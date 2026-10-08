import { useCallback, useEffect, useRef, useState } from "react";
import { uid, type Hotspot, type Scene } from "../db";
import type { LineDef, LinePoint, NotePdf, Stroke } from "../engine/types";
import { angularDistance, drawStrokes, nextLineColor, smoothAndSimplify } from "../engine/lines";
import {
  basisFor,
  clamp,
  MAX_FOV,
  MAX_PITCH,
  MIN_FOV,
  PanoRenderer,
  project,
  unproject,
  wrapAngle,
  rad,
  type Basis,
  type View,
} from "../engine/pano";
import { bitmapSize, closeBitmap, loadBitmap, prepareHotspotPhoto } from "../imageImport";
import { ATTACHMENT_MAX_BYTES, checkAttachment, describeModelError, fileIcon, isViewable3d, normalizeHref } from "../engine/files";
import { loadViewer3d } from "../viewer3dLoader";
import { anglesFromOrientation, GYRO_SUPPORTED, requestGyroPermission } from "../engine/gyro";
import { useFeature } from "../features";
import { useBranding } from "../branding";
import { useT } from "../i18n";
import { getAppLanguage } from "../appLanguage";

interface Props {
  scenes: Scene[]; // весь тур, по порядку
  startId: string;
  editable: boolean; // редактор проекта или просмотр «начисто»
  onClose: () => void;
  onChange?: (scene: Scene) => void; // сохранить изменённую сцену (нужен, если editable)
  mapImage?: Blob; // Функция «Карта тура»: план объекта, один на весь проект
  lines?: LineDef[]; // Функция «Линии»: линии тура (название+цвет)
  onLinesChange?: (lines: LineDef[]) => void;
}

const NO_LINES: LineDef[] = [];

const ROTATE_SPEED = rad(9);
const FRICTION = 6;
const TAP_SLOP = 8;

export default function PanoViewer({ scenes, startId, editable, onClose, onChange, mapImage, lines = NO_LINES, onLinesChange }: Props) {
  const t = useT();
  const [currentId, setCurrentId] = useState(startId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState<"new" | "new-note" | string | null>(null);
  // Функция «Линии»: режим рисования ("points" — по точкам, "free" — от руки),
  // выбранная линия, подсвеченная в легенде линия. Черновик штриха живёт в
  // реф (его читает рендер-цикл каждый кадр), draftCount — только для кнопок.
  const linesEnabled = useFeature("lines");
  const [lineMode, setLineMode] = useState<null | "points" | "free">(null);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [focusLineId, setFocusLineId] = useState<string | null>(null);
  const [draftCount, setDraftCount] = useState(0);
  const [smoothPoints, setSmoothPoints] = useState(true); // «по точкам» → плавная кривая
  const smoothRef = useRef(true);
  smoothRef.current = smoothPoints;
  const draftRef = useRef<LinePoint[]>([]);
  const freeDrawRef = useRef<{ pointerId: number } | null>(null);
  const linesCanvasRef = useRef<HTMLCanvasElement>(null);
  // Какую из прежних заметок подставить в следующую новую («» — пустую).
  const [noteTemplateKey, setNoteTemplateKey] = useState("");
  const [autorotate, setAutorotate] = useState(false);
  const [gyro, setGyro] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [noteHotspot, setNoteHotspot] = useState<Hotspot | null>(null);
  // Открытая в карточке 3D-модель (.glb) и состояние её загрузки.
  const [model3d, setModel3d] = useState<NotePdf | null>(null);
  const [modelStatus, setModelStatus] = useState<"loading" | "ready" | { error: string }>("loading");
  const modelStageRef = useRef<HTMLDivElement | null>(null);
  const model3dRef = useRef(model3d);
  model3dRef.current = model3d;
  const [notePhotoUrl, setNotePhotoUrl] = useState<string | null>(null);
  const [slideshow, setSlideshow] = useState(false);
  const richNotes = useFeature("richNotes");
  const slideshowEnabled = useFeature("slideshow");
  const branding = useBranding();
  const mapEnabled = useFeature("map");
  const [mapOpen, setMapOpen] = useState(false);
  const [mapUrl, setMapUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mapImage) {
      setMapUrl(null);
      return;
    }
    const url = URL.createObjectURL(mapImage);
    setMapUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mapImage]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PanoRenderer | null>(null);
  const viewRef = useRef<View>({ yaw: 0, pitch: 0, fov: rad(75) });
  const velRef = useRef({ yaw: 0, pitch: 0 });
  const hotspotEls = useRef(new Map<string, HTMLElement>());
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef({ active: false, x: 0, y: 0, moved: 0, pinch: 0 });
  const keysRef = useRef(new Set<string>());
  const downTargetRef = useRef<HTMLElement | null>(null);
  const gyroRef = useRef<{ on: boolean; yaw: number; pitch: number; offset: number; init: boolean }>({
    on: false, yaw: 0, pitch: 0, offset: 0, init: false,
  });
  const autoRef = useRef(false);
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  // Esc/аппаратная кнопка «назад» должны закрывать самый верхний открытый
  // слой (карту → карточку заметки → режим расстановки/выбранную точку),
  // а не весь просмотрщик разом — иначе один Esc посреди работы с картой
  // выкидывал из тура целиком. Слушатели ниже — с пустым списком
  // зависимостей (вешаются один раз), поэтому читают состояние через рефы,
  // не напрямую — тот же приём, что и с goToRef/scenesRef в этом файле.
  const mapOpenRef = useRef(mapOpen);
  mapOpenRef.current = mapOpen;
  const lineModeRef = useRef(lineMode);
  lineModeRef.current = lineMode;
  const activeLineIdRef = useRef(activeLineId);
  activeLineIdRef.current = activeLineId;
  const focusLineIdRef = useRef(focusLineId);
  focusLineIdRef.current = focusLineId;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const linesEnabledRef = useRef(linesEnabled);
  linesEnabledRef.current = linesEnabled;
  const noteHotspotRef = useRef(noteHotspot);
  noteHotspotRef.current = noteHotspot;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Возвращает true, если что-то было открыто и теперь закрыто (Esc/назад
  // «поглощены» этим слоем); false — открывать было нечего, можно закрывать
  // просмотрщик целиком.
  const closeTopLayerRef = useRef<() => boolean>(() => false);
  closeTopLayerRef.current = () => {
    if (model3dRef.current) { setModel3d(null); return true; }
    if (mapOpenRef.current) { setMapOpen(false); return true; }
    if (noteHotspotRef.current) { setNoteHotspot(null); return true; }
    if (lineModeRef.current) { exitLineMode(); return true; }
    if (placingRef.current) { setPlacing(null); return true; }
    if (selectedIdRef.current) { setSelectedId(null); return true; }
    return false;
  };
  // goTo сравнивает id с currentId из своего замыкания — эффект автотура
  // ниже создаётся один раз на весь показ (deps: [slideshow]) и звал бы
  // одну и ту же устаревшую версию goTo вечно; храним свежую в рефе.
  const goToRef = useRef<(id: string) => void>(() => {});

  const scene = scenes.find((s) => s.id === currentId) ?? scenes[0];
  const sceneIndex = scenes.findIndex((s) => s.id === scene?.id);

  useEffect(() => { autoRef.current = autorotate; }, [autorotate]);
  useEffect(() => { gyroRef.current.on = gyro; }, [gyro]);

  const flash = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2200);
  }, []);

  useEffect(() => {
    if (!noteHotspot?.photo) {
      setNotePhotoUrl(null);
      return;
    }
    const url = URL.createObjectURL(noteHotspot.photo);
    setNotePhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [noteHotspot]);

  // Черновик штриха принадлежит одной панораме и режиму правки.
  useEffect(() => {
    draftRef.current = [];
    freeDrawRef.current = null;
    setDraftCount(0);
  }, [currentId]);
  useEffect(() => {
    if (!edit) exitLineMode();
  }, [edit]);

  // 3D-просмотрщик: код подключается при первом открытии модели; всё, что он
  // создал (WebGL-контекст, геометрию), освобождаем при закрытии.
  useEffect(() => {
    const model = model3d;
    const stage = modelStageRef.current;
    if (!model?.data || !stage) return;
    setModelStatus("loading");
    let cancelled = false;
    let handle: { dispose(): void } | null = null;
    (async () => {
      try {
        const api = await loadViewer3d();
        const buffer = await model.data!.arrayBuffer();
        if (cancelled) return;
        handle = api.mount(
          stage,
          buffer,
          (message) => { if (!cancelled) setModelStatus({ error: describeModelError(message, getAppLanguage() !== "en") }); },
          () => { if (!cancelled) setModelStatus("ready"); },
          { lang: getAppLanguage() === "en" ? "en" : "ru" },
        );
      } catch {
        if (!cancelled) setModelStatus({ error: describeModelError("", getAppLanguage() !== "en") });
      }
    })();
    // Колесо над окном модели должно приближать модель, а не панораму под ней
    // (на корне просмотрщика колесо слушается нативно).
    const stopWheel = (e: WheelEvent) => e.stopPropagation();
    const overlay = stage.parentElement;
    overlay?.addEventListener("wheel", stopWheel);
    return () => {
      cancelled = true;
      handle?.dispose();
      overlay?.removeEventListener("wheel", stopWheel);
    };
  }, [model3d]);

  // Функция «Автотур»: пока включено, по таймеру переходим на следующую
  // панораму по кругу — рефы вместо scenes/currentId в зависимостях,
  // чтобы не пересоздавать интервал на каждый шаг.
  const SLIDESHOW_INTERVAL = 6000;
  useEffect(() => {
    if (!slideshow) return;
    const id = window.setInterval(() => {
      const list = scenesRef.current;
      if (list.length < 2) return;
      const idx = list.findIndex((s) => s.id === currentIdRef.current);
      if (idx < 0) return;
      goToRef.current(list[(idx + 1) % list.length].id);
    }, SLIDESHOW_INTERVAL);
    return () => window.clearInterval(id);
  }, [slideshow]);

  // ── Рендер-цикл ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new PanoRenderer(canvas);
    rendererRef.current = renderer;
    if (!renderer.ok) {
      setError(t("Браузер не поддерживает WebGL — 360°-панораму показать нечем.", "The browser doesn't support WebGL — no way to show a 360° panorama."));
      setLoading(false);
      return () => { renderer.dispose(); rendererRef.current = null; };
    }

    const layoutHotspots = (basis: Basis, width: number, height: number) => {
      const list = scenesRef.current.find((s) => s.id === currentIdRef.current)?.hotspots ?? [];
      for (const h of list) {
        const el = hotspotEls.current.get(h.id);
        if (!el) continue;
        const p = project(h.yaw, h.pitch, basis, width, height);
        if (!p) {
          el.style.visibility = "hidden";
          continue;
        }
        el.style.visibility = "visible";
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%)`;
      }
    };

    // Функция «Линии»: штрихи рисуем на 2D-канвасе поверх WebGL-панорамы.
    const drawLinesOverlay = (basis: Basis, width: number, height: number) => {
      const lc = linesCanvasRef.current;
      if (!lc) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.round(width * dpr);
      const ph = Math.round(height * dpr);
      if (lc.width !== pw || lc.height !== ph) {
        lc.width = pw;
        lc.height = ph;
      }
      const ctx = lc.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!linesEnabledRef.current) return;
      const strokes = scenesRef.current.find((s) => s.id === currentIdRef.current)?.strokes ?? [];
      const active = linesRef.current.find((l) => l.id === activeLineIdRef.current);
      const draft = draftRef.current.length && active
        ? { points: draftRef.current, color: active.color, vertices: lineModeRef.current === "points", smooth: lineModeRef.current === "points" && smoothRef.current }
        : null;
      drawStrokes(ctx, width, height, basis, strokes, linesRef.current, focusLineIdRef.current, draft);
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      const v = viewRef.current;
      const g = gyroRef.current;

      if (g.on && g.init) {
        const targetYaw = g.yaw + g.offset;
        v.yaw += wrapAngle(targetYaw - v.yaw) * Math.min(1, dt * 12);
        v.pitch += (g.pitch - v.pitch) * Math.min(1, dt * 12);
      } else if (!dragRef.current.active) {
        v.yaw += velRef.current.yaw * dt;
        v.pitch += velRef.current.pitch * dt;
        const damp = Math.exp(-FRICTION * dt);
        velRef.current.yaw *= damp;
        velRef.current.pitch *= damp;
        if (autoRef.current) v.yaw += ROTATE_SPEED * dt;
      }

      const keys = keysRef.current;
      if (keys.size) {
        const step = v.fov * dt;
        if (keys.has("ArrowLeft")) v.yaw -= step;
        if (keys.has("ArrowRight")) v.yaw += step;
        if (keys.has("ArrowUp")) v.pitch += step;
        if (keys.has("ArrowDown")) v.pitch -= step;
      }

      v.yaw = wrapAngle(v.yaw);
      v.pitch = clamp(v.pitch, -MAX_PITCH, MAX_PITCH);

      const { width, height } = renderer.resize();
      const basis = basisFor(v, width, height);
      renderer.render(basis);
      layoutHotspots(basis, width, height);
      drawLinesOverlay(basis, width, height);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // ── Загрузка картинки сцены ─────────────────────────────────────
  useEffect(() => {
    const target = scenesRef.current.find((s) => s.id === currentId);
    if (!target) return;
    const renderer = rendererRef.current;
    if (!renderer || !renderer.ok) return;

    let cancelled = false;
    setLoading(true);
    viewRef.current = {
      yaw: target.yaw,
      pitch: clamp(target.pitch, -MAX_PITCH, MAX_PITCH),
      fov: clamp(target.fov, MIN_FOV, MAX_FOV),
    };
    velRef.current = { yaw: 0, pitch: 0 };
    gyroRef.current.init = false;

    loadBitmap(target.image)
      .then((bmp) => {
        if (cancelled || !rendererRef.current) {
          closeBitmap(bmp);
          return;
        }
        const { width, height } = bitmapSize(bmp);
        const max = rendererRef.current.maxTextureSize;
        if (width > max) {
          const c = document.createElement("canvas");
          c.width = max;
          c.height = Math.max(1, Math.round((max * height) / width));
          c.getContext("2d")!.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
          rendererRef.current.setImage(c, c.width, c.height);
        } else {
          rendererRef.current.setImage(bmp, width, height);
        }
        closeBitmap(bmp);
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("Не удалось открыть панораму — файл повреждён?", "Couldn't open the panorama — is the file corrupted?"));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [currentId]);

  // ── Ввод: свайп, щипок, колесо, клавиши ─────────────────────────
  const pointerDown = (e: React.PointerEvent) => {
    // Режим «от руки»: палец/мышь рисуют штрих, а не вращают панораму
    // (кнопки и точки — data-hud — работают как обычно).
    if (lineModeRef.current === "free" && pointers.current.size === 0 && !(e.target as HTMLElement).closest("[data-hud]")) {
      const p = anglesAt(e.clientX, e.clientY);
      if (p) {
        draftRef.current = [p];
        setDraftCount(1);
        freeDrawRef.current = { pointerId: e.pointerId };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }
      return;
    }
    downTargetRef.current = e.target as HTMLElement;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragRef.current = { active: true, x: e.clientX, y: e.clientY, moved: 0, pinch: pinchDistance() };
    velRef.current = { yaw: 0, pitch: 0 };
  };

  function pinchDistance(): number {
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  const pointerMove = (e: React.PointerEvent) => {
    if (freeDrawRef.current?.pointerId === e.pointerId) {
      const p = anglesAt(e.clientX, e.clientY);
      const last = draftRef.current[draftRef.current.length - 1];
      if (p && (!last || angularDistance(last, p) > rad(0.25))) {
        draftRef.current.push(p);
        setDraftCount(draftRef.current.length);
      }
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = dragRef.current;
    if (!d.active) return;

    if (pointers.current.size >= 2) {
      const dist = pinchDistance();
      if (d.pinch > 0 && dist > 0) {
        const v = viewRef.current;
        v.fov = clamp(v.fov * (d.pinch / dist), MIN_FOV, MAX_FOV);
      }
      d.pinch = dist;
      d.moved += TAP_SLOP;
      return;
    }

    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);

    const rect = wrapRef.current?.getBoundingClientRect();
    const height = rect?.height || window.innerHeight;
    const perPx = viewRef.current.fov / height;
    const dYaw = -dx * perPx;
    const dPitch = dy * perPx;
    if (gyroRef.current.on) {
      gyroRef.current.offset = wrapAngle(gyroRef.current.offset + dYaw);
      return;
    }
    viewRef.current.yaw += dYaw;
    viewRef.current.pitch = clamp(viewRef.current.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
    velRef.current = { yaw: dYaw * 12, pitch: dPitch * 12 };
  };

  const pointerUp = (e: React.PointerEvent) => {
    if (freeDrawRef.current?.pointerId === e.pointerId) {
      freeDrawRef.current = null;
      const stroke = smoothAndSimplify(draftRef.current);
      draftRef.current = [];
      setDraftCount(0);
      commitStroke(stroke);
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const d = dragRef.current;
    if (pointers.current.size === 0) d.active = false;
    d.pinch = pinchDistance();
    if (d.moved < TAP_SLOP) handleTap(e.clientX, e.clientY, downTargetRef.current);
  };

  function handleTap(clientX: number, clientY: number, target: HTMLElement | null) {
    // Режим «по точкам»: каждый тап по панораме — новая вершина ломаной.
    if (lineModeRef.current === "points" && !target?.closest("[data-hud]")) {
      const p = anglesAt(clientX, clientY);
      if (p) {
        draftRef.current = [...draftRef.current, p];
        setDraftCount(draftRef.current.length);
      }
      return;
    }
    const spot = target?.closest<HTMLElement>("[data-spot]");
    if (spot) {
      const h = scene?.hotspots.find((x) => x.id === spot.dataset.spot);
      if (h) activateHotspot(h);
      return;
    }
    if (noteHotspot && !target?.closest("[data-hud]")) {
      setNoteHotspot(null);
      return;
    }
    if (target?.closest("[data-hud]")) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const basis = basisFor(viewRef.current, rect.width, rect.height);
    const { yaw, pitch } = unproject(clientX - rect.left, clientY - rect.top, basis, rect.width, rect.height);

    if (placing && scene && onChange) {
      if (placing === "new" || placing === "new-note") {
        let spotNew: Hotspot;
        if (placing === "new") {
          // Направление по месту клика (перед/зад сферы в абсолютных
          // координатах панорамы) оказалось ненадёжным — зависит от того,
          // как именно снят конкретный кадр, и на реальных турах регулярно
          // угадывало неверно (снимки сделаны примерно в одну сторону, и
          // «назад по маршруту» физически попадает в переднюю половину
          // сферы). Вместо геометрии — по факту: если для этой панорамы
          // ещё нет перехода на следующую по порядку — ставим на неё,
          // иначе если нет на предыдущую — на неё; если обе уже связаны,
          // не гадаем — оставляем без цели, выбор в списке ниже.
          const nextId = nextSceneId();
          const prevId = prevSceneId();
          const linked = new Set(scene.hotspots.map((h) => h.targetId).filter((id): id is string => !!id));
          const targetId = nextId && !linked.has(nextId) ? nextId : prevId && !linked.has(prevId) ? prevId : null;
          const targetTitle = scenes.find((s) => s.id === targetId)?.title ?? t("Переход", "Transition");
          spotNew = { id: uid(), yaw, pitch, label: targetTitle, targetId };
        } else {
          const tpl = noteLibrary().find((x) => x.key === noteTemplateKey);
          spotNew = tpl
            ? { id: uid(), yaw, pitch, label: tpl.hotspot.label, targetId: null, note: tpl.hotspot.note, photo: tpl.hotspot.photo, pdfs: tpl.hotspot.pdfs }
            : { id: uid(), yaw, pitch, label: t("Заметка", "Note"), targetId: null };
        }
        onChange({ ...scene, hotspots: [...scene.hotspots, spotNew] });
        setSelectedId(spotNew.id);
      } else {
        onChange({ ...scene, hotspots: scene.hotspots.map((h) => (h.id === placing ? { ...h, yaw, pitch } : h)) });
      }
      setPlacing(null);
      return;
    }
    setSelectedId(null);
  }

  function nextSceneId(): string | null {
    if (scenes.length < 2) return null;
    return scenes[(sceneIndex + 1) % scenes.length].id;
  }
  function prevSceneId(): string | null {
    if (scenes.length < 2) return null;
    return scenes[(sceneIndex - 1 + scenes.length) % scenes.length].id;
  }

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      v.fov = clamp(v.fov * Math.exp(e.deltaY * 0.0015), MIN_FOV, MAX_FOV);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (closeTopLayerRef.current()) return;
        onClose();
        return;
      }
      if (e.key.startsWith("Arrow")) { keysRef.current.add(e.key); e.preventDefault(); }
      if (e.key === "+" || e.key === "=") viewRef.current.fov = clamp(viewRef.current.fov / 1.15, MIN_FOV, MAX_FOV);
      if (e.key === "-") viewRef.current.fov = clamp(viewRef.current.fov * 1.15, MIN_FOV, MAX_FOV);
    };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      keysRef.current.clear();
    };
  }, [onClose]);

  // Аппаратная/браузерная кнопка «назад» на телефоне иначе уводила бы не
  // из текущего слоя (карты и т.п.), а сразу из редактора целиком — тур
  // открыт не отдельным роутом, а поверх него, так что «назад» без этого
  // просто откатывает историю браузера на предыдущий экран. Кладём одну
  // запись в историю при открытии просмотрщика; «назад» ловим и либо
  // закрываем верхний слой (и возвращаем эту же запись — чтобы следующий
  // «назад» снова сработал так же), либо, если закрывать было нечего,
  // закрываем весь просмотрщик и даём браузеру откатиться взаправду.
  // Осознанно НЕ откатываем свою запись из истории в cleanup при закрытии
  // другим способом (крестик/Esc) — history.back() там асинхронный и под
  // React 18 StrictMode (двойной mount-unmount-remount эффектов в деве)
  // его popstate прилетал не в тот эффект и закрывал просмотрщик сразу
  // после открытия. Цена — одно лишнее (безвредное) нажатие «назад» после
  // закрытия крестиком, только в деве; в проде эффекты не дублируются.
  useEffect(() => {
    window.history.pushState({ panoViewer: true }, "");
    const onPopState = () => {
      if (closeTopLayerRef.current()) {
        window.history.pushState({ panoViewer: true }, "");
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // ── Гироскоп ────────────────────────────────────────────────────
  useEffect(() => {
    if (!gyro) return;
    const onOrient = (e: DeviceOrientationEvent) => {
      const a = anglesFromOrientation(e);
      if (!a) return;
      const g = gyroRef.current;
      if (!g.init) {
        g.offset = wrapAngle(viewRef.current.yaw - a.yaw);
        g.init = true;
      }
      g.yaw = a.yaw;
      g.pitch = a.pitch;
    };
    window.addEventListener("deviceorientation", onOrient);
    const timer = window.setTimeout(() => {
      if (gyroRef.current.init) return;
      setGyro(false);
      flash(t("Датчик наклона недоступен на этом устройстве", "Tilt sensor unavailable on this device"));
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [gyro, flash]);

  async function toggleGyro() {
    if (gyro) { setGyro(false); return; }
    const allowed = await requestGyroPermission();
    if (!allowed) { flash(t("Браузер не дал доступ к датчику наклона", "The browser didn't grant tilt sensor access")); return; }
    gyroRef.current.init = false;
    setGyro(true);
    setAutorotate(false);
  }

  const canFullscreen = typeof document !== "undefined" && !!document.documentElement.requestFullscreen;
  useEffect(() => {
    const onChangeFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChangeFs);
    return () => document.removeEventListener("fullscreenchange", onChangeFs);
  }, []);
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrapRef.current?.requestFullscreen?.().catch(() => flash(t("Полный экран недоступен", "Fullscreen unavailable")));
  }

  function saveStartView() {
    if (!scene || !onChange) return;
    const v = viewRef.current;
    onChange({ ...scene, yaw: v.yaw, pitch: v.pitch, fov: v.fov });
    flash(t("Стартовый вид сохранён", "Starting view saved"));
  }
  function updateHotspot(id: string, patch: Partial<Hotspot>) {
    if (!scene || !onChange) return;
    onChange({ ...scene, hotspots: scene.hotspots.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
  }
  function deleteHotspot(id: string) {
    if (!scene || !onChange) return;
    onChange({ ...scene, hotspots: scene.hotspots.filter((h) => h.id !== id) });
    hotspotEls.current.delete(id);
    setSelectedId(null);
    setPlacing(null);
  }

  // ── Функция «Линии» ────────────────────────────────────────────
  function anglesAt(clientX: number, clientY: number): LinePoint | null {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const basis = basisFor(viewRef.current, rect.width, rect.height);
    return unproject(clientX - rect.left, clientY - rect.top, basis, rect.width, rect.height);
  }
  function exitLineMode() {
    freeDrawRef.current = null;
    draftRef.current = [];
    setDraftCount(0);
    setLineMode(null);
  }
  function commitStroke(points: LinePoint[], smooth = false) {
    const lineId = activeLineIdRef.current;
    if (!scene || !onChange || !lineId || points.length < 2) return;
    const stroke: Stroke = { id: uid(), lineId, points, ...(smooth && points.length > 2 ? { smooth: true } : {}) };
    onChange({ ...scene, strokes: [...(scene.strokes ?? []), stroke] });
  }
  function finishPointStroke() {
    commitStroke(draftRef.current, smoothRef.current);
    draftRef.current = [];
    setDraftCount(0);
  }
  function createLine(): LineDef | null {
    if (!onLinesChange) return null;
    const name = window.prompt(t("Название линии (например, A1):", "Line name (e.g. A1):"), `A${lines.length + 1}`)?.trim();
    if (!name) return null;
    const line: LineDef = { id: uid(), name, color: nextLineColor(lines) };
    onLinesChange([...lines, line]);
    setActiveLineId(line.id);
    activeLineIdRef.current = line.id;
    return line;
  }
  function startLineMode(mode: "points" | "free") {
    if (lineMode === mode) { exitLineMode(); return; }
    let id = activeLineIdRef.current;
    if (!id || !lines.some((l) => l.id === id)) {
      const created = lines.length === 1 ? lines[0] : createLine();
      if (!created) return;
      id = created.id;
      setActiveLineId(id);
      activeLineIdRef.current = id;
    }
    draftRef.current = [];
    setDraftCount(0);
    setSelectedId(null);
    setPlacing(null);
    setLineMode(mode);
  }
  function undoStroke() {
    if (!scene || !onChange || !scene.strokes?.length) return;
    onChange({ ...scene, strokes: scene.strokes.slice(0, -1) });
  }
  function clearLineHere() {
    if (!scene || !onChange || !activeLineId) return;
    onChange({ ...scene, strokes: (scene.strokes ?? []).filter((st) => st.lineId !== activeLineId) });
  }
  function renameLine(id: string) {
    const line = lines.find((l) => l.id === id);
    const name = line && window.prompt(t("Название линии:", "Line name:"), line.name)?.trim();
    if (name) onLinesChange?.(lines.map((l) => (l.id === id ? { ...l, name } : l)));
  }
  function recolorLine(id: string, color: string) {
    onLinesChange?.(lines.map((l) => (l.id === id ? { ...l, color } : l)));
  }
  function deleteLine(id: string) {
    const line = lines.find((l) => l.id === id);
    if (!line || !window.confirm(t(`Удалить линию «${line.name}» со всех панорам?`, `Delete line "${line.name}" from all panoramas?`))) return;
    exitLineMode();
    onLinesChange?.(lines.filter((l) => l.id !== id));
    if (activeLineId === id) setActiveLineId(null);
    if (focusLineId === id) setFocusLineId(null);
    for (const sc of scenes) {
      if (sc.strokes?.some((st) => st.lineId === id)) onChange?.({ ...sc, strokes: sc.strokes.filter((st) => st.lineId !== id) });
    }
  }

  function goTo(id: string) {
    if (id === currentId) return;
    setSelectedId(null);
    setPlacing(null);
    setNoteHotspot(null);
    setCurrentId(id);
  }
  goToRef.current = goTo;

  function activateHotspot(h: Hotspot) {
    if (edit) { setSelectedId(h.id); return; }
    if (h.targetId && scenes.some((s) => s.id === h.targetId)) { goTo(h.targetId); return; }
    if (richNotes && (h.note?.trim() || h.photo || h.pdfs?.length)) { setNoteHotspot(h); return; }
    flash(h.label);
  }

  async function pickNotePhoto(hotspotId: string, file: File | undefined) {
    if (!file) return;
    const photo = await prepareHotspotPhoto(file);
    updateHotspot(hotspotId, { photo });
  }

  // Вложения заметки (PDF, DWG, 3D-модели — любой файл): можно прикрепить
  // несколько, каждый скачивается отдельной кнопкой на карточке.
  function addNotePdfs(hotspotId: string, files: FileList | null) {
    if (!files?.length) return;
    const current = scene?.hotspots.find((x) => x.id === hotspotId)?.pdfs ?? [];
    const added: NotePdf[] = [];
    for (const file of Array.from(files)) {
      const problem = checkAttachment(file);
      if (problem === "blocked") { flash(t(`«${file.name}» — такой тип файла прикрепить нельзя`, `"${file.name}" — this file type can't be attached`)); continue; }
      if (problem === "empty") { flash(t(`«${file.name}» — пустой файл`, `"${file.name}" is empty`)); continue; }
      if (problem === "too-big") {
        const mb = Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024);
        flash(t(`«${file.name}» больше ${mb} МБ — заархивируйте или сожмите`, `"${file.name}" is over ${mb} MB — zip or compress it`));
        continue;
      }
      added.push({ name: file.name, data: file });
    }
    if (added.length) updateHotspot(hotspotId, { pdfs: [...current, ...added] });
  }
  function removeNotePdf(hotspotId: string, index: number) {
    const current = scene?.hotspots.find((x) => x.id === hotspotId)?.pdfs ?? [];
    const next = current.filter((_, i) => i !== index);
    updateHotspot(hotspotId, { pdfs: next.length ? next : undefined });
  }
  function openAttachment(pdf: NotePdf) {
    if (pdf.href) { window.open(pdf.href, "_blank", "noopener,noreferrer"); return; }
    if (isViewable3d(pdf.name) && pdf.data) { setModel3d(pdf); return; }
    downloadPdf(pdf);
  }
  function addNoteLink(hotspotId: string) {
    const raw = window.prompt(t("Ссылка (например, на модель в Autodesk Viewer):", "Link (e.g. to a model in Autodesk Viewer):"), "https://");
    if (raw === null) return;
    const href = normalizeHref(raw);
    if (!href) { flash(t("Нужна ссылка вида https://…", "A link like https://… is required")); return; }
    const defaultName = new URL(href).hostname.replace(/^www\./, "");
    const name = window.prompt(t("Название ссылки:", "Link title:"), defaultName)?.trim() || defaultName;
    const current = scene?.hotspots.find((x) => x.id === hotspotId)?.pdfs ?? [];
    updateHotspot(hotspotId, { pdfs: [...current, { name, href }] });
  }
  function downloadPdf(pdf: NotePdf) {
    if (!pdf.data) return;
    const url = URL.createObjectURL(pdf.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = pdf.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // Библиотека прежних заметок всего тура: информационные точки (без
  // перехода), в которых есть что показать. Одинаковые (то же название и
  // текст — например, скопированные на соседние панорамы) показываем один раз.
  function noteLibrary(excludeId?: string): { key: string; text: string; hotspot: Hotspot }[] {
    const seen = new Set<string>();
    const out: { key: string; text: string; hotspot: Hotspot }[] = [];
    for (const s of scenes) {
      for (const h of s.hotspots) {
        if (h.targetId || h.id === excludeId) continue;
        if (!h.note?.trim() && !h.photo && !h.pdfs?.length) continue;
        const key = `${h.label} ${h.note ?? ""} ${(h.pdfs ?? []).map((x) => x.name).join("|")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const extras = [h.photo ? "🖼" : "", h.pdfs?.length ? `📎${h.pdfs.length}` : ""].filter(Boolean).join(" ");
        out.push({ key, text: `${h.label} · ${s.title}${extras ? " " + extras : ""}`, hotspot: h });
      }
    }
    return out;
  }
  function fillFromNote(hotspotId: string, key: string) {
    const tpl = noteLibrary(hotspotId).find((x) => x.key === key);
    if (!tpl) return;
    updateHotspot(hotspotId, { label: tpl.hotspot.label, note: tpl.hotspot.note, photo: tpl.hotspot.photo, pdfs: tpl.hotspot.pdfs });
  }

  // «Соседние» — сцены, куда есть переход прямо с текущей (обычно предыдущая
  // и следующая по маршруту). Заметка часто видна с нескольких соседних
  // точек съёмки, поэтому её можно скопировать туда же одним нажатием.
  function neighborScenes(): Scene[] {
    if (!scene) return [];
    const ids = new Set(scene.hotspots.map((h) => h.targetId).filter((id): id is string => !!id));
    return scenes.filter((s) => ids.has(s.id));
  }
  function propagateNoteToNeighbors(h: Hotspot) {
    if (!onChange) return;
    const neighbors = neighborScenes();
    let added = 0;
    for (const neighbor of neighbors) {
      if (neighbor.hotspots.some((x) => !x.targetId && x.label === h.label)) continue;
      const clone: Hotspot = {
        id: uid(), yaw: h.yaw, pitch: h.pitch, label: h.label, targetId: null,
        note: h.note, photo: h.photo, pdfs: h.pdfs,
      };
      onChange({ ...neighbor, hotspots: [...neighbor.hotspots, clone] });
      added++;
    }
    flash(
      added > 0
        ? t(`Заметка добавлена на соседние панорамы (${added})`, `Note added to neighboring panoramas (${added})`)
        : t("На соседних панорамах уже есть такая заметка", "Neighboring panoramas already have this note"),
    );
  }

  const selected = scene?.hotspots.find((h) => h.id === selectedId) ?? null;
  const activeLine = lines.find((l) => l.id === activeLineId) ?? null;
  const sceneLineIds = lines.filter((l) => scene?.strokes?.some((st) => st.lineId === l.id)).map((l) => l.id);

  if (!scene) return null;

  return (
    <div
      className="pano-wrap"
      ref={wrapRef}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
    >
      <canvas ref={canvasRef} className="pano-canvas" />
      <canvas ref={linesCanvasRef} className="pano-lines" />

      {scene.hotspots.map((h) => (
        <button
          key={h.id}
          data-hud
          data-spot={h.id}
          className={`pano-spot${selectedId === h.id ? " sel" : ""}${h.targetId ? "" : " note"}`}
          ref={(el) => {
            if (el) hotspotEls.current.set(h.id, el);
            else hotspotEls.current.delete(h.id);
          }}
          style={{ visibility: "hidden" }}
          onClick={(e) => { if (e.detail === 0) activateHotspot(h); }}
          title={h.label}
        >
          <span className="pano-spot-dot" />
          <span className="pano-spot-label">{h.label}</span>
        </button>
      ))}

      <div className={`pano-veil${loading || error ? " on" : ""}`}>
        {error ? <div className="pano-error">{error}</div> : <div className="pano-loader">{t("Загружаю панораму…", "Loading panorama…")}</div>}
      </div>

      <div className="pano-top" data-hud onPointerDown={(e) => e.stopPropagation()}>
        <div className="pano-title">
          <b>{scene.title}</b>
          <span className="pano-sub">{sceneIndex + 1} / {scenes.length}</span>
        </div>
        <div className="pano-tools">
          {slideshowEnabled && scenes.length > 1 && (
            <button className={`pano-btn${slideshow ? " on" : ""}`} onClick={() => setSlideshow(!slideshow)} title={t("Автотур (слайд-шоу)", "Auto tour (slideshow)")}>▶</button>
          )}
          <button className={`pano-btn${autorotate ? " on" : ""}`} onClick={() => { setAutorotate(!autorotate); setGyro(false); }} title={t("Автоповорот", "Auto-rotate")}>↻</button>
          {GYRO_SUPPORTED && (
            <button className={`pano-btn${gyro ? " on" : ""}`} onClick={toggleGyro} title={t("Поворот по наклону телефона", "Rotate by tilting the phone")}>🧭</button>
          )}
          {canFullscreen && (
            <button className="pano-btn" onClick={toggleFullscreen} title={t("Во весь экран", "Fullscreen")}>{fullscreen ? "⤡" : "⤢"}</button>
          )}
          {editable && (
            <button className={`pano-btn${edit ? " on" : ""}`} onClick={() => { setEdit(!edit); setSelectedId(null); setPlacing(null); }} title={t("Редактировать переходы", "Edit transitions")}>✏️</button>
          )}
          <button className="pano-btn close" onClick={onClose} title={t("Закрыть", "Close")}>✕</button>
        </div>
      </div>

      {linesEnabled && sceneLineIds.length > 0 && (
        <div className="pano-legend" data-hud onPointerDown={(e) => e.stopPropagation()}>
          {sceneLineIds.map((id) => {
            const def = lines.find((l) => l.id === id);
            if (!def) return null;
            return (
              <button
                key={id}
                className={`pano-legend-chip${focusLineId === id ? " on" : ""}`}
                onClick={() => setFocusLineId(focusLineId === id ? null : id)}
                title={t("Подсветить линию", "Highlight line")}
              >
                <span className="pano-legend-dot" style={{ background: def.color }} />
                {def.name}
              </button>
            );
          })}
        </div>
      )}

      {edit && editable && (
        <div className="pano-edit" data-hud onPointerDown={(e) => e.stopPropagation()}>
          {selected ? (
            <>
              <div className="row" style={{ gap: 6 }}>
                <input className="pano-input grow" value={selected.label} onChange={(e) => updateHotspot(selected.id, { label: e.target.value })} placeholder={t("Подпись", "Label")} />
                <button className="pano-btn" onClick={() => setSelectedId(null)}>✕</button>
              </div>
              <select className="pano-input" value={selected.targetId ?? ""} onChange={(e) => updateHotspot(selected.id, { targetId: e.target.value || null })}>
                <option value="">{t("Без перехода (просто подпись)", "No transition (label only)")}</option>
                {scenes.filter((s) => s.id !== scene.id).map((s) => (
                  <option key={s.id} value={s.id}>{t("Перейти", "Go to")}: {s.title}</option>
                ))}
              </select>
              {richNotes && !selected.targetId && (
                <>
                  {noteLibrary(selected.id).length > 0 && (
                    <select
                      className="pano-input"
                      value=""
                      onChange={(e) => fillFromNote(selected.id, e.target.value)}
                    >
                      <option value="">{t("Заполнить из прежней заметки…", "Fill from a previous note…")}</option>
                      {noteLibrary(selected.id).map((x) => (
                        <option key={x.key} value={x.key}>{x.text}</option>
                      ))}
                    </select>
                  )}
                  <textarea
                    className="pano-input"
                    rows={3}
                    placeholder={t("Описание для карточки (необязательно)", "Card description (optional)")}
                    value={selected.note ?? ""}
                    onChange={(e) => updateHotspot(selected.id, { note: e.target.value })}
                  />
                  <div className="row" style={{ gap: 6 }}>
                    <label className="pano-btn wide" style={{ textAlign: "center", cursor: "pointer" }}>
                      {selected.photo ? t("Заменить фото", "Replace photo") : t("+ Фото", "+ Photo")}
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => pickNotePhoto(selected.id, e.target.files?.[0])}
                      />
                    </label>
                    {selected.photo && (
                      <button className="pano-btn" onClick={() => updateHotspot(selected.id, { photo: undefined })} title={t("Убрать фото", "Remove photo")}>✕ {t("фото", "photo")}</button>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <label className="pano-btn wide" style={{ textAlign: "center", cursor: "pointer" }}>
                      {t("+ Файл (PDF, DWG, 3D…)", "+ File (PDF, DWG, 3D…)")}
                      <input
                        type="file"
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => { addNotePdfs(selected.id, e.target.files); e.target.value = ""; }}
                      />
                    </label>
                    <button className="pano-btn wide" onClick={() => addNoteLink(selected.id)}>{t("+ Ссылка", "+ Link")}</button>
                  </div>
                  {selected.pdfs?.map((pdf, i) => (
                    <div key={i} className="row" style={{ gap: 6 }}>
                      <span className="pano-pdf-name grow" title={pdf.href ?? pdf.name}>{pdf.href ? "🔗" : fileIcon(pdf.name)} {pdf.name}</span>
                      <button className="pano-btn" onClick={() => removeNotePdf(selected.id, i)} title={t("Убрать файл", "Remove file")}>✕</button>
                    </div>
                  ))}
                  {neighborScenes().length > 0 && (
                    <button className="pano-btn wide" onClick={() => propagateNoteToNeighbors(selected)}>
                      {t("Показать и на соседних панорамах", "Also show on neighboring panoramas")}
                    </button>
                  )}
                </>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button className={`pano-btn wide${placing === selected.id ? " on" : ""}`} onClick={() => setPlacing(placing === selected.id ? null : selected.id)}>
                  {placing === selected.id ? t("Нажми на панораму…", "Tap the panorama…") : t("Переставить", "Reposition")}
                </button>
                <button className="pano-btn wide danger" onClick={() => deleteHotspot(selected.id)}>{t("Удалить", "Delete")}</button>
              </div>
            </>
          ) : (
            <>
              {richNotes && noteLibrary().length > 0 && (
                <select className="pano-input" value={noteTemplateKey} onChange={(e) => setNoteTemplateKey(e.target.value)}>
                  <option value="">{t("Новая заметка: пустая", "New note: empty")}</option>
                  {noteLibrary().map((x) => (
                    <option key={x.key} value={x.key}>{t("Новая заметка из прежней: ", "New note from previous: ")}{x.text}</option>
                  ))}
                </select>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button className={`pano-btn wide${placing === "new" ? " on" : ""}`} onClick={() => setPlacing(placing === "new" ? null : "new")}>
                  {placing === "new" ? t("Нажми, куда поставить", "Tap where to place it") : t("+ Переход", "+ Transition")}
                </button>
                {richNotes && (
                  <button className={`pano-btn wide${placing === "new-note" ? " on" : ""}`} onClick={() => setPlacing(placing === "new-note" ? null : "new-note")}>
                    {placing === "new-note" ? t("Нажми, куда поставить", "Tap where to place it") : t("+ Заметка", "+ Note")}
                  </button>
                )}
              </div>
              {linesEnabled && onLinesChange && (
                <>
                  <div className="row" style={{ gap: 6 }}>
                    <select
                      className="pano-input grow"
                      value={activeLine?.id ?? ""}
                      onChange={(e) => {
                        if (e.target.value === "__new") { createLine(); return; }
                        setActiveLineId(e.target.value || null);
                      }}
                    >
                      <option value="">{t("Линия…", "Line…")}</option>
                      {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      <option value="__new">{t("➕ Новая линия…", "➕ New line…")}</option>
                    </select>
                    {activeLine && (
                      <>
                        <input
                          type="color"
                          className="pano-color"
                          value={activeLine.color}
                          onChange={(e) => recolorLine(activeLine.id, e.target.value)}
                          title={t("Цвет линии", "Line colour")}
                        />
                        <button className="pano-btn" onClick={() => renameLine(activeLine.id)} title={t("Переименовать", "Rename")}>✎</button>
                        <button className="pano-btn" onClick={() => deleteLine(activeLine.id)} title={t("Удалить линию", "Delete line")}>🗑</button>
                      </>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className={`pano-btn wide${lineMode === "points" ? " on" : ""}`} onClick={() => startLineMode("points")}>〰 {t("По точкам", "By points")}</button>
                    <button className={`pano-btn wide${lineMode === "free" ? " on" : ""}`} onClick={() => startLineMode("free")}>✍ {t("От руки", "Freehand")}</button>
                  </div>
                  {lineMode ? (
                    <>
                      <div className="pano-hint-line">
                        {lineMode === "points"
                          ? t("Тапайте вдоль линии — каждая точка добавляет изгиб. Панораму можно вращать перетаскиванием.", "Tap along the line — each tap adds a bend. You can still rotate the panorama by dragging.")
                          : t("Ведите пальцем/мышью вдоль линии — штрих рисуется, пока держите.", "Drag along the line to paint it — it draws while you hold.")}
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        {lineMode === "points" && (
                          <>
                            <button className="pano-btn wide on" disabled={draftCount < 2} onClick={finishPointStroke}>✓ {t("Готово", "Done")}{draftCount ? ` (${draftCount})` : ""}</button>
                            <button className="pano-btn" disabled={!draftCount} onClick={() => { draftRef.current = draftRef.current.slice(0, -1); setDraftCount(draftRef.current.length); }} title={t("Убрать последнюю точку", "Remove last point")}>↶ {t("точка", "point")}</button>
                            <button className={`pano-btn${smoothPoints ? " on" : ""}`} onClick={() => setSmoothPoints(!smoothPoints)} title={t("Плавная кривая вместо ломаной", "Smooth curve instead of a polyline")}>〜 {t("Сгладить", "Smooth")}</button>
                          </>
                        )}
                        {lineMode === "free" && (
                          <button className="pano-btn wide" disabled={!scene.strokes?.length} onClick={undoStroke}>↶ {t("Отменить штрих", "Undo stroke")}</button>
                        )}
                        <button className="pano-btn" onClick={exitLineMode}>✕ {t("Выход", "Exit")}</button>
                      </div>
                    </>
                  ) : (
                    !!scene.strokes?.length && (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="pano-btn wide" onClick={undoStroke}>↶ {t("Отменить последний штрих", "Undo last stroke")}</button>
                        {activeLine && scene.strokes.some((st) => st.lineId === activeLine.id) && (
                          <button className="pano-btn wide" onClick={clearLineHere}>🧽 {t("Стереть линию здесь", "Erase line here")}</button>
                        )}
                      </div>
                    )
                  )}
                </>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button className="pano-btn wide" onClick={saveStartView}>{t("Запомнить вид", "Remember view")}</button>
              </div>
            </>
          )}
        </div>
      )}

      {scenes.length > 1 && (
        <div
          className="pano-strip"
          data-hud
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => {
            // Скроллбар у полоски скрыт для чистого вида — без этого при
            // большом числе панорам мышью просто нечем долистать до тех,
            // что не влезли на экран (обычная вертикальная прокрутка колесом
            // тут ничего не делает, полоска не выше экрана). Отдаём и
            // вертикальный, и горизонтальный delta — трекпад уже шлёт
            // горизонтальный сам, мышь — только вертикальный.
            e.currentTarget.scrollLeft += e.deltaY || e.deltaX;
          }}
        >
          {scenes.map((s) => (
            <button key={s.id} className={`pano-chip${s.id === scene.id ? " on" : ""}`} onClick={() => goTo(s.id)}>{s.title}</button>
          ))}
        </div>
      )}

      {noteHotspot && (
        <div className="pano-note" data-hud onPointerDown={(e) => e.stopPropagation()}>
          {notePhotoUrl && <img className="pano-note-photo" src={notePhotoUrl} alt="" />}
          <div className="pano-note-body">
            <div className="pano-note-title">
              <span>{noteHotspot.label}</span>
              <button className="pano-note-close" onClick={() => setNoteHotspot(null)} aria-label={t("Закрыть", "Close")}>✕</button>
            </div>
            {noteHotspot.note && <div className="pano-note-text">{noteHotspot.note}</div>}
            {noteHotspot.pdfs?.map((pdf, i) => (
              <div key={i} className="pano-note-filerow">
                <button className="pano-note-pdf" onClick={() => openAttachment(pdf)}>
                  <span className="pano-note-pdf-name">{pdf.href ? "🔗" : fileIcon(pdf.name)} {pdf.name}</span>
                  <span className="pano-note-pdf-dl">
                    {pdf.href ? `↗ ${t("Открыть", "Open")}` : isViewable3d(pdf.name) ? `👁 ${t("Смотреть 3D", "View 3D")}` : `⬇ ${t("Скачать", "Download")}`}
                  </span>
                </button>
                {!pdf.href && isViewable3d(pdf.name) && (
                  <button className="pano-note-dlbtn" onClick={() => downloadPdf(pdf)} title={t("Скачать файл", "Download file")} aria-label={t("Скачать файл", "Download file")}>⬇</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {model3d && (
        <div className="pano-model" data-hud onPointerDown={(e) => e.stopPropagation()}>
          <div className="pano-model-bar">
            <span className="pano-model-title">🧊 {model3d.name}</span>
            <button className="pano-btn" onClick={() => downloadPdf(model3d)} title={t("Скачать файл", "Download file")}>⬇</button>
            <button className="pano-btn close" onClick={() => setModel3d(null)} title={t("Закрыть", "Close")}>✕</button>
          </div>
          <div className="pano-model-stage" ref={modelStageRef} />
          {modelStatus === "loading" && <div className="pano-model-msg">{t("Загружаю модель…", "Loading model…")}</div>}
          {typeof modelStatus === "object" && <div className="pano-model-msg err">{modelStatus.error}</div>}
          {modelStatus === "ready" && <div className="pano-model-hint">{t("Вращение — перетаскивание · масштаб — колесо/щипок · сдвиг — правая кнопка/два пальца · расстояния — «📏 Замер»", "Rotate — drag · zoom — wheel/pinch · pan — right button/two fingers · distances — “📏 Measure”")}</div>}
        </div>
      )}

      {(branding.logo || branding.text) && (
        <div className="pano-brand">
          {branding.logo && <img src={branding.logo} alt="" />}
          {branding.text && <span>{branding.text}</span>}
        </div>
      )}

      {toast && <div className="pano-toast">{toast}</div>}

      {mapEnabled && mapUrl && !edit && !mapOpen && (
        <button className="pano-map-mini" data-hud onPointerDown={(e) => e.stopPropagation()} onClick={() => setMapOpen(true)} title={t("Развернуть карту", "Expand map")}>
          <img src={mapUrl} alt="" />
          {scenes
            .filter((s) => s.mapX != null && s.mapY != null)
            .map((s) => (
              <span
                key={s.id}
                className={`pano-map-mini-pin${s.id === scene.id ? " on" : ""}`}
                style={{ left: `${s.mapX}%`, top: `${s.mapY}%` }}
              />
            ))}
          <span className="pano-map-mini-expand">⤢</span>
        </button>
      )}

      {mapOpen && mapUrl && (
        <div className="pano-map" data-hud onPointerDown={(e) => e.stopPropagation()}>
          <button className="pano-btn close pano-map-close" onClick={() => setMapOpen(false)} title={t("Закрыть", "Close")}>✕</button>
          <div className="pano-map-frame">
            <img src={mapUrl} alt="" />
            {scenes
              .filter((s) => s.mapX != null && s.mapY != null)
              .map((s) => (
                <button
                  key={s.id}
                  className={`pano-map-pin${s.id === scene.id ? " on" : ""}`}
                  style={{ left: `${s.mapX}%`, top: `${s.mapY}%` }}
                  onClick={() => { goTo(s.id); setMapOpen(false); }}
                  title={s.title}
                >
                  <span className="pano-map-pin-label">{s.title}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
