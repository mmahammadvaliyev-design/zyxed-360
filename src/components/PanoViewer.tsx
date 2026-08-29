import { useCallback, useEffect, useRef, useState } from "react";
import { uid, type Hotspot, type Scene } from "../db";
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
import { anglesFromOrientation, GYRO_SUPPORTED, requestGyroPermission } from "../engine/gyro";
import { useFeature } from "../features";
import { useBranding } from "../branding";

interface Props {
  scenes: Scene[]; // весь тур, по порядку
  startId: string;
  editable: boolean; // редактор проекта или просмотр «начисто»
  onClose: () => void;
  onChange?: (scene: Scene) => void; // сохранить изменённую сцену (нужен, если editable)
}

const ROTATE_SPEED = rad(9);
const FRICTION = 6;
const TAP_SLOP = 8;

export default function PanoViewer({ scenes, startId, editable, onClose, onChange }: Props) {
  const [currentId, setCurrentId] = useState(startId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState<"new" | "new-note" | string | null>(null);
  const [autorotate, setAutorotate] = useState(false);
  const [gyro, setGyro] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [noteHotspot, setNoteHotspot] = useState<Hotspot | null>(null);
  const [notePhotoUrl, setNotePhotoUrl] = useState<string | null>(null);
  const [slideshow, setSlideshow] = useState(false);
  const richNotes = useFeature("richNotes");
  const slideshowEnabled = useFeature("slideshow");
  const brandingEnabled = useFeature("branding");
  const branding = useBranding();
  const i18nEnabled = useFeature("i18n");
  const [lang, setLang] = useState<"ru" | "en">("ru");

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
      setError("Браузер не поддерживает WebGL — 360°-панораму показать нечем.");
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
        setError("Не удалось открыть панораму — файл повреждён?");
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [currentId]);

  // ── Ввод: свайп, щипок, колесо, клавиши ─────────────────────────
  const pointerDown = (e: React.PointerEvent) => {
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
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const d = dragRef.current;
    if (pointers.current.size === 0) d.active = false;
    d.pinch = pinchDistance();
    if (d.moved < TAP_SLOP) handleTap(e.clientX, e.clientY, downTargetRef.current);
  };

  function handleTap(clientX: number, clientY: number, target: HTMLElement | null) {
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
          // Ставим точку слева (по вкусу — "назад") — раньше это всё равно
          // вело на следующую сцену; теперь направление берём из места
          // клика: передняя половина сферы — вперёд, задняя — назад.
          const targetId = Math.abs(wrapAngle(yaw)) < Math.PI / 2 ? nextSceneId() : prevSceneId();
          const targetTitle = scenes.find((s) => s.id === targetId)?.title ?? "Переход";
          spotNew = { id: uid(), yaw, pitch, label: targetTitle, targetId };
        } else {
          spotNew = { id: uid(), yaw, pitch, label: "Заметка", targetId: null };
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
      if (e.key === "Escape") { onClose(); return; }
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
      flash("Датчик наклона недоступен на этом устройстве");
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [gyro, flash]);

  async function toggleGyro() {
    if (gyro) { setGyro(false); return; }
    const allowed = await requestGyroPermission();
    if (!allowed) { flash("Браузер не дал доступ к датчику наклона"); return; }
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
    else wrapRef.current?.requestFullscreen?.().catch(() => flash("Полный экран недоступен"));
  }

  function saveStartView() {
    if (!scene || !onChange) return;
    const v = viewRef.current;
    onChange({ ...scene, yaw: v.yaw, pitch: v.pitch, fov: v.fov });
    flash("Стартовый вид сохранён");
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
    if (richNotes && (h.note?.trim() || h.photo)) { setNoteHotspot(h); return; }
    flash(hotspotLabel(h));
  }

  async function pickNotePhoto(hotspotId: string, file: File | undefined) {
    if (!file) return;
    const photo = await prepareHotspotPhoto(file);
    updateHotspot(hotspotId, { photo });
  }

  // Функция «RU/EN тур»: если для текущего языка нет перевода — молча
  // показываем русский, а не пусто.
  function sceneTitle(s: Scene): string {
    return lang === "en" && s.titleEn?.trim() ? s.titleEn : s.title;
  }
  function hotspotLabel(h: Hotspot): string {
    return lang === "en" && h.labelEn?.trim() ? h.labelEn : h.label;
  }
  function hotspotNote(h: Hotspot): string | undefined {
    return lang === "en" && h.noteEn?.trim() ? h.noteEn : h.note;
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
        id: uid(), yaw: h.yaw, pitch: h.pitch, label: h.label, labelEn: h.labelEn, targetId: null,
        note: h.note, noteEn: h.noteEn, photo: h.photo,
      };
      onChange({ ...neighbor, hotspots: [...neighbor.hotspots, clone] });
      added++;
    }
    flash(added > 0 ? `Заметка добавлена на соседние панорамы (${added})` : "На соседних панорамах уже есть такая заметка");
  }

  const selected = scene?.hotspots.find((h) => h.id === selectedId) ?? null;

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
          title={hotspotLabel(h)}
        >
          <span className="pano-spot-dot" />
          <span className="pano-spot-label">{hotspotLabel(h)}</span>
        </button>
      ))}

      <div className={`pano-veil${loading || error ? " on" : ""}`}>
        {error ? <div className="pano-error">{error}</div> : <div className="pano-loader">Загружаю панораму…</div>}
      </div>

      <div className="pano-top" data-hud onPointerDown={(e) => e.stopPropagation()}>
        <div className="pano-title">
          <b>{sceneTitle(scene)}</b>
          <span className="pano-sub">{sceneIndex + 1} / {scenes.length}</span>
        </div>
        <div className="pano-tools">
          {slideshowEnabled && scenes.length > 1 && (
            <button className={`pano-btn${slideshow ? " on" : ""}`} onClick={() => setSlideshow(!slideshow)} title="Автотур (слайд-шоу)">▶</button>
          )}
          <button className={`pano-btn${autorotate ? " on" : ""}`} onClick={() => { setAutorotate(!autorotate); setGyro(false); }} title="Автоповорот">↻</button>
          {GYRO_SUPPORTED && (
            <button className={`pano-btn${gyro ? " on" : ""}`} onClick={toggleGyro} title="Поворот по наклону телефона">🧭</button>
          )}
          {canFullscreen && (
            <button className="pano-btn" onClick={toggleFullscreen} title="Во весь экран">{fullscreen ? "⤡" : "⤢"}</button>
          )}
          {i18nEnabled && (
            <button className="pano-btn" onClick={() => setLang(lang === "ru" ? "en" : "ru")} title="Язык / Language">
              {lang === "ru" ? "RU" : "EN"}
            </button>
          )}
          {editable && (
            <button className={`pano-btn${edit ? " on" : ""}`} onClick={() => { setEdit(!edit); setSelectedId(null); setPlacing(null); }} title="Редактировать переходы">✏️</button>
          )}
          <button className="pano-btn close" onClick={onClose} title="Закрыть">✕</button>
        </div>
      </div>

      {edit && editable && (
        <div className="pano-edit" data-hud onPointerDown={(e) => e.stopPropagation()}>
          {selected ? (
            <>
              <div className="row" style={{ gap: 6 }}>
                <input className="pano-input grow" value={selected.label} onChange={(e) => updateHotspot(selected.id, { label: e.target.value })} placeholder="Подпись" />
                <button className="pano-btn" onClick={() => setSelectedId(null)}>✕</button>
              </div>
              {i18nEnabled && (
                <input
                  className="pano-input"
                  value={selected.labelEn ?? ""}
                  onChange={(e) => updateHotspot(selected.id, { labelEn: e.target.value })}
                  placeholder="Label (English)"
                />
              )}
              <select className="pano-input" value={selected.targetId ?? ""} onChange={(e) => updateHotspot(selected.id, { targetId: e.target.value || null })}>
                <option value="">Без перехода (просто подпись)</option>
                {scenes.filter((s) => s.id !== scene.id).map((s) => (
                  <option key={s.id} value={s.id}>Перейти: {s.title}</option>
                ))}
              </select>
              {richNotes && !selected.targetId && (
                <>
                  <textarea
                    className="pano-input"
                    rows={3}
                    placeholder="Описание для карточки (необязательно)"
                    value={selected.note ?? ""}
                    onChange={(e) => updateHotspot(selected.id, { note: e.target.value })}
                  />
                  {i18nEnabled && (
                    <textarea
                      className="pano-input"
                      rows={3}
                      placeholder="Description (English)"
                      value={selected.noteEn ?? ""}
                      onChange={(e) => updateHotspot(selected.id, { noteEn: e.target.value })}
                    />
                  )}
                  <div className="row" style={{ gap: 6 }}>
                    <label className="pano-btn wide" style={{ textAlign: "center", cursor: "pointer" }}>
                      {selected.photo ? "Заменить фото" : "+ Фото"}
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => pickNotePhoto(selected.id, e.target.files?.[0])}
                      />
                    </label>
                    {selected.photo && (
                      <button className="pano-btn" onClick={() => updateHotspot(selected.id, { photo: undefined })} title="Убрать фото">✕ фото</button>
                    )}
                  </div>
                  {neighborScenes().length > 0 && (
                    <button className="pano-btn wide" onClick={() => propagateNoteToNeighbors(selected)}>
                      Показать и на соседних панорамах
                    </button>
                  )}
                </>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button className={`pano-btn wide${placing === selected.id ? " on" : ""}`} onClick={() => setPlacing(placing === selected.id ? null : selected.id)}>
                  {placing === selected.id ? "Нажми на панораму…" : "Переставить"}
                </button>
                <button className="pano-btn wide danger" onClick={() => deleteHotspot(selected.id)}>Удалить</button>
              </div>
            </>
          ) : (
            <>
              <div className="row" style={{ gap: 6 }}>
                <button className={`pano-btn wide${placing === "new" ? " on" : ""}`} onClick={() => setPlacing(placing === "new" ? null : "new")}>
                  {placing === "new" ? "Нажми, куда поставить" : "+ Переход"}
                </button>
                {richNotes && (
                  <button className={`pano-btn wide${placing === "new-note" ? " on" : ""}`} onClick={() => setPlacing(placing === "new-note" ? null : "new-note")}>
                    {placing === "new-note" ? "Нажми, куда поставить" : "+ Заметка"}
                  </button>
                )}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="pano-btn wide" onClick={saveStartView}>Запомнить вид</button>
              </div>
            </>
          )}
        </div>
      )}

      {scenes.length > 1 && (
        <div className="pano-strip" data-hud onPointerDown={(e) => e.stopPropagation()}>
          {scenes.map((s) => (
            <button key={s.id} className={`pano-chip${s.id === scene.id ? " on" : ""}`} onClick={() => goTo(s.id)}>{sceneTitle(s)}</button>
          ))}
        </div>
      )}

      {noteHotspot && (
        <div className="pano-note" data-hud onPointerDown={(e) => e.stopPropagation()}>
          {notePhotoUrl && <img className="pano-note-photo" src={notePhotoUrl} alt="" />}
          <div className="pano-note-body">
            <div className="pano-note-title">
              <span>{hotspotLabel(noteHotspot)}</span>
              <button className="pano-note-close" onClick={() => setNoteHotspot(null)} aria-label="Закрыть">✕</button>
            </div>
            {hotspotNote(noteHotspot) && <div className="pano-note-text">{hotspotNote(noteHotspot)}</div>}
          </div>
        </div>
      )}

      {brandingEnabled && (branding.logo || branding.text) && (
        <div className="pano-brand">
          {branding.logo && <img src={branding.logo} alt="" />}
          {branding.text && <span>{branding.text}</span>}
        </div>
      )}

      {toast && <div className="pano-toast">{toast}</div>}
    </div>
  );
}
