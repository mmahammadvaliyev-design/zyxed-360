// Автономный плеер опубликованного тура. Без React и без базы данных — только
// движок панорамы (../src/engine) и данные из data.json/images/*, которые
// экспорт кладёт рядом с этими файлами. Открывается прямо с диска или с любого
// статического хостинга.
import {
  basisFor,
  clamp,
  MAX_FOV,
  MAX_PITCH,
  MIN_FOV,
  PanoRenderer,
  project,
  wrapAngle,
  rad,
  type Basis,
  type View,
} from "../src/engine/pano";
import { anglesFromOrientation, GYRO_SUPPORTED, requestGyroPermission } from "../src/engine/gyro";
import { loadBitmap, bitmapSize, closeBitmap } from "../src/engine/bitmap";
import type { Hotspot, NotePdf, SceneMeta, TourManifest } from "../src/engine/types";
import { drawStrokes, hitTestStrokes, lineHasDocs } from "../src/engine/lines";
import type { LineDef } from "../src/engine/types";
import { dataUrlToBytes, describeModelError, fileIcon, isViewable3d, mimeForName } from "../src/engine/files";

const ROTATE_SPEED = rad(9);
const FRICTION = 6;
const TAP_SLOP = 8;

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="pano-wrap" id="wrap">
    <canvas class="pano-canvas" id="canvas"></canvas>
    <canvas class="pano-lines" id="lines"></canvas>
    <div class="pano-veil on" id="veil"><div class="pano-loader" id="veil-text">Загружаю тур…</div></div>
    <div class="pano-top" data-hud id="top" hidden>
      <div class="pano-title"><b id="title"></b><span class="pano-sub" id="sub"></span></div>
      <div class="pano-tools">
        <button class="pano-btn" id="btn-slideshow" title="Автотур (слайд-шоу)" hidden>▶</button>
        <button class="pano-btn on" id="btn-spots" title="Скрыть переходы (они останутся кликабельными)" hidden>◎</button>
        <button class="pano-btn on" id="btn-lines" title="Скрыть линии" hidden>〰</button>
        <button class="pano-btn" id="btn-rotate" title="Автоповорот">↻</button>
        <button class="pano-btn" id="btn-gyro" title="Поворот по наклону телефона" hidden>🧭</button>
        <button class="pano-btn" id="btn-fs" title="Во весь экран" hidden>⤢</button>
      </div>
    </div>
    <div class="pano-legend" data-hud id="legend" hidden></div>
    <div class="pano-strip" data-hud id="strip" hidden></div>
    <div class="pano-toast" id="toast" hidden></div>
    <button class="pano-map-mini" data-hud id="map-mini" title="Развернуть карту" hidden>
      <img id="map-mini-img" alt="" />
      <span class="pano-map-mini-expand">⤢</span>
    </button>
    <div class="pano-map" data-hud id="map-overlay" hidden>
      <button class="pano-btn close pano-map-close" id="map-close">✕</button>
      <div class="pano-map-frame" id="map-frame">
        <img id="map-img" alt="" />
      </div>
    </div>
  </div>
`;

const wrapEl = document.getElementById("wrap")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const linesCanvas = document.getElementById("lines") as HTMLCanvasElement;
const legendEl = document.getElementById("legend")!;
legendEl.addEventListener("pointerdown", (e) => e.stopPropagation());
const veil = document.getElementById("veil")!;
const veilText = document.getElementById("veil-text")!;
const topBar = document.getElementById("top")!;
const titleEl = document.getElementById("title")!;
const subEl = document.getElementById("sub")!;
const stripEl = document.getElementById("strip")!;
const toastEl = document.getElementById("toast")!;
const btnSlideshow = document.getElementById("btn-slideshow") as HTMLButtonElement;
const btnRotate = document.getElementById("btn-rotate") as HTMLButtonElement;
const btnLines = document.getElementById("btn-lines") as HTMLButtonElement;
const btnSpots = document.getElementById("btn-spots") as HTMLButtonElement;
const btnGyro = document.getElementById("btn-gyro") as HTMLButtonElement;
const btnFs = document.getElementById("btn-fs") as HTMLButtonElement;
const mapMini = document.getElementById("map-mini") as HTMLButtonElement;
const mapMiniImg = document.getElementById("map-mini-img") as HTMLImageElement;
const mapOverlay = document.getElementById("map-overlay") as HTMLDivElement;
const mapClose = document.getElementById("map-close") as HTMLButtonElement;
const mapFrame = document.getElementById("map-frame") as HTMLDivElement;
const mapImgEl = document.getElementById("map-img") as HTMLImageElement;

// Без этого клик по кнопкам интерфейса перехватывается жестом на панораме:
// wrapEl.setPointerCapture() ниже переносит последующий click на себя же,
// если pointerdown успел всплыть досюда.
topBar.addEventListener("pointerdown", (e) => e.stopPropagation());
stripEl.addEventListener("pointerdown", (e) => e.stopPropagation());
mapOverlay.addEventListener("pointerdown", (e) => e.stopPropagation());
mapMini.addEventListener("pointerdown", (e) => e.stopPropagation());
// Скроллбар у полоски скрыт для чистого вида — без этого при большом числе
// панорам мышью просто нечем долистать до тех, что не влезли на экран.
stripEl.addEventListener(
  "wheel",
  (e) => {
    stripEl.scrollLeft += e.deltaY || e.deltaX;
  },
  { passive: true },
);

let toastTimer = 0;
function flash(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2200);
}

const renderer = new PanoRenderer(canvas);
if (!renderer.ok) {
  veilText.textContent = "Браузер не поддерживает WebGL — 360°-панораму показать нечем.";
  throw new Error("no webgl");
}

let manifest: TourManifest;
let scenes: SceneMeta[] = [];
let currentIndex = 0;
const view: View = { yaw: 0, pitch: 0, fov: rad(75) };
const vel = { yaw: 0, pitch: 0 };
let autorotate = false;
let gyroOn = false;
const gyroState = { yaw: 0, pitch: 0, offset: 0, init: false };
const keys = new Set<string>();
const hotspotEls = new Map<string, HTMLElement>();
const mapPinEls = new Map<string, HTMLElement>();
const mapMiniPinEls = new Map<string, HTMLElement>();
const pointers = new Map<number, { x: number; y: number }>();
const drag = { active: false, x: 0, y: 0, moved: 0, pinch: 0 };
let downTarget: HTMLElement | null = null;
let loadToken = 0;
let noteEl: HTMLElement | null = null;
// Функция «RU/EN тур»: язык — не переключатель внутри тура, а то, что было
// выбрано в приложении на момент экспорта (manifest.lang, см. bundle.ts).
// Если для этого языка нет перевода конкретного поля — молча показываем
// русский, а не пусто.
let lang: "ru" | "en" = "ru";

function currentScene(): SceneMeta | undefined {
  return scenes[currentIndex];
}

// Функция «Линии»: легенда — линии, проходящие через текущую панораму; нажатие
// подсвечивает линию (остальные приглушаются), повторное — снимает подсветку.
let focusLineId: string | null = null;
// Скрытые переходы: маркер не виден, но кликабельная зона остаётся.
let spotsHidden = false;
function applySpotVisibility() {
  for (const h of currentScene()?.hotspots ?? []) {
    hotspotEls.get(h.id)?.classList.toggle("stealth", !!h.targetId && (spotsHidden || !!h.hidden));
  }
}
let linesVisible = true;

// Документация линии показывается тем же окном, что и заметка: собираем
// «псевдо-заметку» из линии.
function lineToHotspot(l: LineDef): Hotspot {
  return { id: `line:${l.id}`, yaw: 0, pitch: 0, label: l.name, targetId: null, note: l.note, photoUrl: l.photoUrl, pdfs: l.pdfs };
}

// Линия под точкой касания (только те, у которых есть документация).
function lineAt(clientX: number, clientY: number): LineDef | null {
  const scene = currentScene();
  // Зоны кликабельны всегда: и у «невидимых» линий, и когда линии скрыты
  // кнопкой 〰 (она прячет только рисунок и легенду).
  const all = manifest?.lines ?? [];
  if (!manifest?.features?.lines || !scene?.strokes?.length || !all.length) return null;
  const rect = wrapEl.getBoundingClientRect();
  const basis = basisFor(view, rect.width, rect.height);
  const id = hitTestStrokes(scene.strokes, all, basis, rect.width, rect.height, clientX - rect.left, clientY - rect.top, scene.lineWidths);
  return all.find((l) => l.id === id) ?? null;
}

function renderLegend() {
  legendEl.innerHTML = "";
  const lines = manifest.lines ?? [];
  const strokes = currentScene()?.strokes ?? [];
  const present = lines.filter((l) => strokes.some((st) => st.lineId === l.id));
  legendEl.hidden = !manifest.features?.lines || present.length === 0;
  for (const l of present) {
    const chip = document.createElement("button");
    chip.className = "pano-legend-chip" + (focusLineId === l.id ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "pano-legend-dot";
    dot.style.background = l.color;
    chip.append(dot, document.createTextNode(l.name));
    if (lineHasDocs(l)) {
      const clip = document.createElement("span");
      clip.className = "pano-legend-doc";
      clip.textContent = "📎";
      chip.appendChild(clip);
      chip.title = "Подсветить и открыть документацию";
    }
    if (l.hidden) {
      const eye = document.createElement("span");
      eye.className = "pano-legend-doc";
      eye.textContent = "🙈";
      chip.appendChild(eye);
    }
    chip.addEventListener("click", () => {
      focusLineId = focusLineId === l.id ? null : l.id;
      if (focusLineId && lineHasDocs(l)) openNote(lineToHotspot(l));
      else if (!focusLineId) closeNote();
      renderLegend();
    });
    legendEl.appendChild(chip);
  }
}

function pinchDistance(): number {
  const pts = [...pointers.values()];
  if (pts.length < 2) return 0;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

function renderHotspots(scene: SceneMeta) {
  hotspotEls.forEach((el) => el.remove());
  hotspotEls.clear();
  for (const h of scene.hotspots) {
    const btn = document.createElement("button");
    btn.className = `pano-spot${h.targetId ? "" : " note"}${h.targetId && (spotsHidden || h.hidden) ? " stealth" : ""}`;
    btn.dataset.hud = "1";
    btn.dataset.spot = h.id;
    btn.style.visibility = "hidden";
    btn.title = h.label;
    btn.innerHTML = `<span class="pano-spot-dot"></span><span class="pano-spot-label"></span>`;
    (btn.querySelector(".pano-spot-label") as HTMLElement).textContent = h.label;
    btn.addEventListener("click", (e) => {
      if ((e as MouseEvent).detail === 0) activateHotspot(h);
    });
    wrapEl.appendChild(btn);
    hotspotEls.set(h.id, btn);
  }
}

function closeNote() {
  noteEl?.remove();
  noteEl = null;
}

// Вложение в манифесте — data: URI. Скачиваем через Blob + object URL: так
// работает и под file://, и с большими файлами (data: в href упирается в
// лимиты браузеров).
function downloadPdf(pdf: NotePdf) {
  if (!pdf.url) return;
  const url = URL.createObjectURL(new Blob([dataUrlToBytes(pdf.url)], { type: mimeForName(pdf.name) }));
  const a = document.createElement("a");
  a.href = url;
  a.download = pdf.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Окно 3D-модели (.glb) поверх тура. Код просмотрщика (three.js) лежит в
// отдельном assets/viewer3d.js и подключён в index.html только если в туре
// есть модель (см. bundle.ts) — window.Zyxed3D.
let modelEl: HTMLElement | null = null;
let modelHandle: { dispose(): void } | null = null;

function closeModel() {
  modelHandle?.dispose();
  modelHandle = null;
  modelEl?.remove();
  modelEl = null;
}

function openModel(pdf: NotePdf) {
  closeModel();
  const ru = lang !== "en";
  const overlay = document.createElement("div");
  overlay.className = "pano-model";
  overlay.dataset.hud = "1";
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
  // Колесо над моделью приближает модель, а не панораму под ней.
  overlay.addEventListener("wheel", (e) => e.stopPropagation());

  const bar = document.createElement("div");
  bar.className = "pano-model-bar";
  const title = document.createElement("span");
  title.className = "pano-model-title";
  title.textContent = "🧊 " + pdf.name;
  const dl = document.createElement("button");
  dl.className = "pano-btn";
  dl.textContent = "⬇";
  dl.title = ru ? "Скачать файл" : "Download file";
  dl.addEventListener("click", () => downloadPdf(pdf));
  const close = document.createElement("button");
  close.className = "pano-btn close";
  close.textContent = "✕";
  close.title = ru ? "Закрыть" : "Close";
  close.addEventListener("click", closeModel);
  bar.append(title, dl, close);

  const stage = document.createElement("div");
  stage.className = "pano-model-stage";
  const msg = document.createElement("div");
  msg.className = "pano-model-msg";
  msg.textContent = ru ? "Загружаю модель…" : "Loading model…";
  const hint = document.createElement("div");
  hint.className = "pano-model-hint";
  hint.textContent = ru
    ? "Вращение — перетаскивание · масштаб — колесо/щипок · сдвиг — правая кнопка/два пальца · расстояния — «📏 Замер»"
    : "Rotate — drag · zoom — wheel/pinch · pan — right button/two fingers · distances — “📏 Measure”";
  hint.hidden = true;
  overlay.append(bar, stage, msg, hint);
  wrapEl.appendChild(overlay);
  modelEl = overlay;

  const api = window.Zyxed3D;
  if (!api || !pdf.url) {
    msg.classList.add("err");
    msg.textContent = describeModelError("", ru);
    return;
  }
  const bytes = dataUrlToBytes(pdf.url);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  modelHandle = api.mount(
    stage,
    buffer,
    (message) => {
      msg.hidden = false;
      msg.classList.add("err");
      msg.textContent = describeModelError(message, ru);
    },
    () => {
      msg.hidden = true;
      hint.hidden = false;
    },
    { lang: ru ? "ru" : "en" },
  );
}

// Функция «Богатые заметки»: постоянная карточка с описанием/фото вместо
// короткого тоста — только если фича была включена на момент экспорта
// (manifest.features, см. src/export/bundle.ts) и у точки есть что показать.
// Окно документации открывается сбоку — на стороне, противоположной месту
// нажатия, чтобы не закрывать трубу; его можно перетащить за заголовок.
let noteSide: "left" | "right" = "right";

// Повторное нажатие на тот же значок/линию закрывает окно.
function toggleNote(h: Hotspot) {
  if (noteEl && noteEl.dataset.noteId === h.id) closeNote();
  else openNote(h);
}

function openNote(h: Hotspot) {
  closeNote();
  const card = document.createElement("div");
  card.className = "pano-note side-" + noteSide;
  card.dataset.noteId = h.id;
  card.dataset.hud = "1";
  card.addEventListener("pointerdown", (e) => e.stopPropagation());

  if (h.photoUrl) {
    const img = document.createElement("img");
    img.className = "pano-note-photo";
    img.src = h.photoUrl;
    img.alt = "";
    card.appendChild(img);
  }
  const body = document.createElement("div");
  body.className = "pano-note-body";
  const title = document.createElement("div");
  title.className = "pano-note-title";
  const label = document.createElement("span");
  label.textContent = h.label;
  const closeBtn = document.createElement("button");
  closeBtn.className = "pano-note-close";
  closeBtn.setAttribute("aria-label", "Закрыть");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeNote);
  title.append(label, closeBtn);
  title.title = lang === "en" ? "Drag to move this window" : "Перетащите, чтобы переместить окно";
  let drag: { dx: number; dy: number } | null = null;
  const place = (x: number, y: number) => {
    card.style.left = x + "px";
    card.style.top = y + "px";
    card.style.right = "auto";
    card.style.bottom = "auto";
    card.style.margin = "0";
    card.style.transform = "none";
  };
  title.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const cr = card.getBoundingClientRect();
    const wr = wrapEl.getBoundingClientRect();
    drag = { dx: e.clientX - cr.left, dy: e.clientY - cr.top };
    place(cr.left - wr.left, cr.top - wr.top);
    try { title.setPointerCapture(e.pointerId); } catch { /* указатель уже неактивен */ }
  });
  title.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const cr = card.getBoundingClientRect();
    const wr = wrapEl.getBoundingClientRect();
    place(
      clamp(e.clientX - wr.left - drag.dx, 0, Math.max(0, wr.width - cr.width)),
      clamp(e.clientY - wr.top - drag.dy, 0, Math.max(0, wr.height - cr.height)),
    );
  });
  const endDrag = () => { drag = null; };
  title.addEventListener("pointerup", endDrag);
  title.addEventListener("pointercancel", endDrag);
  body.appendChild(title);
  const noteText = h.note;
  if (noteText) {
    const text = document.createElement("div");
    text.className = "pano-note-text";
    text.textContent = noteText;
    body.appendChild(text);
  }
  for (const pdf of h.pdfs ?? []) {
    const ru = lang !== "en";
    const viewable = !pdf.href && !!pdf.url && isViewable3d(pdf.name);
    const row = document.createElement("div");
    row.className = "pano-note-filerow";
    const btn = document.createElement("button");
    btn.className = "pano-note-pdf";
    const name = document.createElement("span");
    name.className = "pano-note-pdf-name";
    name.textContent = (pdf.href ? "🔗" : fileIcon(pdf.name)) + " " + pdf.name;
    const action = document.createElement("span");
    action.className = "pano-note-pdf-dl";
    action.textContent = pdf.href
      ? "↗ " + (ru ? "Открыть" : "Open")
      : viewable
        ? "👁 " + (ru ? "Смотреть 3D" : "View 3D")
        : "⬇ " + (ru ? "Скачать" : "Download");
    btn.append(name, action);
    btn.addEventListener("click", () => {
      if (pdf.href) window.open(pdf.href, "_blank", "noopener,noreferrer");
      else if (viewable) openModel(pdf);
      else downloadPdf(pdf);
    });
    row.appendChild(btn);
    if (viewable) {
      const dlBtn = document.createElement("button");
      dlBtn.className = "pano-note-dlbtn";
      dlBtn.textContent = "⬇";
      dlBtn.title = ru ? "Скачать файл" : "Download file";
      dlBtn.addEventListener("click", () => downloadPdf(pdf));
      row.appendChild(dlBtn);
    }
    body.appendChild(row);
  }
  card.appendChild(body);
  wrapEl.appendChild(card);
  noteEl = card;
}

function activateHotspot(h: Hotspot) {
  if (h.targetId) {
    const idx = scenes.findIndex((s) => s.id === h.targetId);
    if (idx >= 0) {
      goTo(idx);
      return;
    }
  }
  if (manifest.features?.richNotes && (h.note || h.photoUrl || h.pdfs?.length)) {
    toggleNote(h);
    return;
  }
  flash(h.label);
}

function renderStrip() {
  stripEl.innerHTML = "";
  stripEl.hidden = scenes.length < 2;
  scenes.forEach((s, i) => {
    const chip = document.createElement("button");
    chip.className = `pano-chip${i === currentIndex ? " on" : ""}`;
    chip.dataset.hud = "1";
    chip.textContent = s.title;
    chip.addEventListener("click", () => goTo(i));
    stripEl.appendChild(chip);
  });
}

// Функция «Карта тура»: план объекта с точками съёмки — только те сцены,
// для которых точка была вручную расставлена в редакторе (mapX/mapY заданы).
// Полный план (mapFrame) открывается по клику на всегда видимую миниатюру
// (mapMini) — сама миниатюра только для ориентира, не кликабельна по точкам.
function renderMapPins() {
  mapFrame.querySelectorAll(".pano-map-pin").forEach((el) => el.remove());
  mapPinEls.clear();
  mapMini.querySelectorAll(".pano-map-mini-pin").forEach((el) => el.remove());
  mapMiniPinEls.clear();
  scenes.forEach((s, i) => {
    if (s.mapX == null || s.mapY == null) return;
    const pin = document.createElement("button");
    pin.className = `pano-map-pin${i === currentIndex ? " on" : ""}`;
    pin.style.left = `${s.mapX}%`;
    pin.style.top = `${s.mapY}%`;
    pin.title = s.title;
    const label = document.createElement("span");
    label.className = "pano-map-pin-label";
    label.textContent = s.title;
    pin.appendChild(label);
    pin.addEventListener("click", () => {
      goTo(i);
      mapOverlay.hidden = true;
      mapMini.hidden = false;
    });
    mapFrame.appendChild(pin);
    mapPinEls.set(s.id, pin);

    const miniPin = document.createElement("span");
    miniPin.className = `pano-map-mini-pin${i === currentIndex ? " on" : ""}`;
    miniPin.style.left = `${s.mapX}%`;
    miniPin.style.top = `${s.mapY}%`;
    mapMini.appendChild(miniPin);
    mapMiniPinEls.set(s.id, miniPin);
  });
}

function updateMapPinHighlight() {
  const id = currentScene()?.id;
  mapPinEls.forEach((el, pinId) => el.classList.toggle("on", pinId === id));
  mapMiniPinEls.forEach((el, pinId) => el.classList.toggle("on", pinId === id));
}

async function goTo(index: number) {
  currentIndex = index;
  const scene = scenes[index];
  if (!scene) return;
  const token = ++loadToken;
  closeNote();
  closeModel();

  titleEl.textContent = scene.title;
  subEl.textContent = `${index + 1} / ${scenes.length}`;
  renderHotspots(scene);
  renderLegend();
  renderStrip();
  updateMapPinHighlight();

  view.yaw = scene.yaw;
  view.pitch = clamp(scene.pitch, -MAX_PITCH, MAX_PITCH);
  view.fov = clamp(scene.fov, MIN_FOV, MAX_FOV);
  vel.yaw = 0;
  vel.pitch = 0;
  gyroState.init = false;

  veil.classList.add("on");
  veilText.textContent = "Загружаю панораму…";
  try {
    // Встроенные data: URI из манифеста грузятся через тот же fetch() без
    // ограничений file://; внешний images/<id>.jpg — запасной путь, если
    // манифест почему-то пришёл без картинок (см. readEmbeddedManifest).
    const src = manifest.images?.[scene.id] ?? `./images/${scene.id}.jpg`;
    const res = await fetch(src);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const bmp = await loadBitmap(blob);
    if (token !== loadToken) {
      closeBitmap(bmp);
      return;
    }
    const { width, height } = bitmapSize(bmp);
    const max = renderer.maxTextureSize;
    if (width > max) {
      const c = document.createElement("canvas");
      c.width = max;
      c.height = Math.max(1, Math.round((max * height) / width));
      c.getContext("2d")!.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
      renderer.setImage(c, c.width, c.height);
    } else {
      renderer.setImage(bmp, width, height);
    }
    closeBitmap(bmp);
    veil.classList.remove("on");
  } catch {
    if (token !== loadToken) return;
    veilText.textContent = "Не удалось загрузить панораму.";
  }
}

// ── Ввод ────────────────────────────────────────────────────────
wrapEl.addEventListener("pointerdown", (e) => {
  downTarget = e.target as HTMLElement;
  try { wrapEl.setPointerCapture?.(e.pointerId); } catch { /* указатель уже неактивен */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  drag.active = true;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.moved = 0;
  drag.pinch = pinchDistance();
  vel.yaw = 0;
  vel.pitch = 0;
});

wrapEl.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && e.buttons === 0) wrapEl.style.cursor = lineAt(e.clientX, e.clientY) ? "pointer" : "";
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag.active) return;

  if (pointers.size >= 2) {
    const dist = pinchDistance();
    if (drag.pinch > 0 && dist > 0) view.fov = clamp(view.fov * (drag.pinch / dist), MIN_FOV, MAX_FOV);
    drag.pinch = dist;
    drag.moved += TAP_SLOP;
    return;
  }

  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.moved += Math.abs(dx) + Math.abs(dy);

  const rect = wrapEl.getBoundingClientRect();
  const perPx = view.fov / (rect.height || window.innerHeight);
  const dYaw = -dx * perPx;
  const dPitch = dy * perPx;
  if (gyroOn) {
    gyroState.offset = wrapAngle(gyroState.offset + dYaw);
    return;
  }
  view.yaw += dYaw;
  view.pitch = clamp(view.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
  vel.yaw = dYaw * 12;
  vel.pitch = dPitch * 12;
});

function onPointerUp(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) drag.active = false;
  drag.pinch = pinchDistance();
  if (drag.moved < TAP_SLOP) handleTap(downTarget, e.clientX, e.clientY);
}
wrapEl.addEventListener("pointerup", onPointerUp);
wrapEl.addEventListener("pointercancel", onPointerUp);

function handleTap(target: HTMLElement | null, clientX: number, clientY: number) {
  const wr0 = wrapEl.getBoundingClientRect();
  noteSide = clientX < wr0.left + wr0.width / 2 ? "right" : "left";
  const spot = target?.closest<HTMLElement>("[data-spot]");
  if (spot) {
    const h = currentScene()?.hotspots.find((x) => x.id === spot.dataset.spot);
    if (h) activateHotspot(h);
    return;
  }
  // Функция «Линии»: тап по зоне линии с документацией (даже невидимой) открывает карточку.
  if (!target?.closest("[data-hud]")) {
    const line = lineAt(clientX, clientY);
    if (line) {
      if (lineHasDocs(line)) toggleNote(lineToHotspot(line));
      else { closeNote(); flash(line.name); } // документации нет — закрываем старую карточку и называем линию
      return;
    }
  }
  if (noteEl && !target?.closest("[data-hud]")) closeNote();
}

wrapEl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    view.fov = clamp(view.fov * Math.exp(e.deltaY * 0.0015), MIN_FOV, MAX_FOV);
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  // Пока открыта 3D-модель, клавиши не должны крутить панораму под ней.
  if (modelEl) {
    if (e.key === "Escape") closeModel();
    return;
  }
  if (e.key.startsWith("Arrow")) {
    keys.add(e.key);
    e.preventDefault();
  }
  if (e.key === "+" || e.key === "=") view.fov = clamp(view.fov / 1.15, MIN_FOV, MAX_FOV);
  if (e.key === "-") view.fov = clamp(view.fov * 1.15, MIN_FOV, MAX_FOV);
});
window.addEventListener("keyup", (e) => keys.delete(e.key));

btnSpots.addEventListener("click", () => {
  spotsHidden = !spotsHidden;
  btnSpots.classList.toggle("on", !spotsHidden);
  btnSpots.title = spotsHidden ? "Показать переходы" : "Скрыть переходы (они останутся кликабельными)";
  applySpotVisibility();
});

btnLines.addEventListener("click", () => {
  linesVisible = !linesVisible;
  btnLines.classList.toggle("on", linesVisible);
  btnLines.title = linesVisible ? "Скрыть линии (зоны остаются кликабельными)" : "Показать линии";
  renderLegend();
});

btnRotate.addEventListener("click", () => {
  autorotate = !autorotate;
  if (autorotate) { gyroOn = false; btnGyro.classList.remove("on"); }
  btnRotate.classList.toggle("on", autorotate);
});

// Функция «Автотур»: по таймеру переходим на следующую панораму по кругу.
const SLIDESHOW_INTERVAL = 6000;
let slideshowTimer = 0;
btnSlideshow.addEventListener("click", () => {
  const on = !btnSlideshow.classList.contains("on");
  btnSlideshow.classList.toggle("on", on);
  window.clearInterval(slideshowTimer);
  if (on) {
    slideshowTimer = window.setInterval(() => {
      if (scenes.length > 1) goTo((currentIndex + 1) % scenes.length);
    }, SLIDESHOW_INTERVAL);
  }
});

if (GYRO_SUPPORTED) {
  btnGyro.hidden = false;
  let orientReceived = false;
  let gyroFallbackTimer = 0;

  window.addEventListener("deviceorientation", (e) => {
    if (!gyroOn) return;
    const a = anglesFromOrientation(e);
    if (!a) return;
    orientReceived = true;
    if (!gyroState.init) {
      gyroState.offset = wrapAngle(view.yaw - a.yaw);
      gyroState.init = true;
    }
    gyroState.yaw = a.yaw;
    gyroState.pitch = a.pitch;
  });

  btnGyro.addEventListener("click", async () => {
    window.clearTimeout(gyroFallbackTimer);
    if (gyroOn) {
      gyroOn = false;
      btnGyro.classList.remove("on");
      return;
    }
    const allowed = await requestGyroPermission();
    if (!allowed) {
      flash("Браузер не дал доступ к датчику наклона");
      return;
    }
    gyroState.init = false;
    orientReceived = false;
    gyroOn = true;
    autorotate = false;
    btnRotate.classList.remove("on");
    btnGyro.classList.add("on");
    // На компьютере датчика нет: событие не придёт — тихо выключаемся, чтобы вид не «залип».
    // Таймер заводим заново при каждом включении, а не один раз при загрузке страницы.
    gyroFallbackTimer = window.setTimeout(() => {
      if (gyroOn && !orientReceived) {
        gyroOn = false;
        btnGyro.classList.remove("on");
        flash("Датчик наклона недоступен на этом устройстве");
      }
    }, 2000);
  });
}

mapMini.addEventListener("click", () => { mapOverlay.hidden = false; mapMini.hidden = true; });
mapClose.addEventListener("click", () => { mapOverlay.hidden = true; mapMini.hidden = false; });

if (typeof document.documentElement.requestFullscreen === "function") {
  btnFs.hidden = false;
  btnFs.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrapEl.requestFullscreen?.().catch(() => flash("Полный экран недоступен"));
  });
  document.addEventListener("fullscreenchange", () => {
    btnFs.textContent = document.fullscreenElement ? "⤡" : "⤢";
  });
}

// ── Цикл рендера ────────────────────────────────────────────────
let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.064, (now - last) / 1000);
  last = now;

  if (gyroOn && gyroState.init) {
    const targetYaw = gyroState.yaw + gyroState.offset;
    view.yaw += wrapAngle(targetYaw - view.yaw) * Math.min(1, dt * 12);
    view.pitch += (gyroState.pitch - view.pitch) * Math.min(1, dt * 12);
  } else if (!drag.active) {
    view.yaw += vel.yaw * dt;
    view.pitch += vel.pitch * dt;
    const damp = Math.exp(-FRICTION * dt);
    vel.yaw *= damp;
    vel.pitch *= damp;
    if (autorotate) view.yaw += ROTATE_SPEED * dt;
  }

  if (keys.size) {
    const step = view.fov * dt;
    if (keys.has("ArrowLeft")) view.yaw -= step;
    if (keys.has("ArrowRight")) view.yaw += step;
    if (keys.has("ArrowUp")) view.pitch += step;
    if (keys.has("ArrowDown")) view.pitch -= step;
  }

  view.yaw = wrapAngle(view.yaw);
  view.pitch = clamp(view.pitch, -MAX_PITCH, MAX_PITCH);

  const { width, height } = renderer.resize();
  const basis: Basis = basisFor(view, width, height);
  renderer.render(basis);

  const scene = currentScene();
  drawLinesLayer(basis, width, height, scene);
  if (scene) {
    for (const h of scene.hotspots) {
      const el = hotspotEls.get(h.id);
      if (!el) continue;
      const p = project(h.yaw, h.pitch, basis, width, height);
      if (!p) {
        el.style.visibility = "hidden";
        continue;
      }
      el.style.visibility = "visible";
      el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%)`;
    }
  }
}
requestAnimationFrame(frame);

function drawLinesLayer(basis: Basis, width: number, height: number, scene: SceneMeta | undefined) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(width * dpr);
  const ph = Math.round(height * dpr);
  if (linesCanvas.width !== pw || linesCanvas.height !== ph) {
    linesCanvas.width = pw;
    linesCanvas.height = ph;
  }
  const ctx = linesCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!manifest?.features?.lines || !scene?.strokes?.length) return;
  // Скрытый режим (кнопка 〰): рисунок не показываем, кроме линии, выбранной в легенде.
  const strokes = linesVisible ? scene.strokes : scene.strokes.filter((st) => st.lineId === focusLineId);
  if (!strokes.length) return;
  drawStrokes(ctx, width, height, basis, strokes, manifest.lines ?? [], focusLineId, null, false, scene.lineWidths);
}

// ── Старт: подгружаем данные тура ─────────────────────────────────
// Экспорт встраивает манифест прямо в страницу (id="tour-data") — так пакет
// открывается и двойным кликом с диска, без запроса data.json, который
// браузеры блокируют для файлов file://. Если тега нет (например, эту
// страницу открыли отдельно от экспорта), пробуем ./data.json как раньше.
function readEmbeddedManifest(): TourManifest | null {
  const el = document.getElementById("tour-data");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as TourManifest;
  } catch {
    return null;
  }
}

function startTour(data: TourManifest) {
  manifest = data;
  document.title = manifest.title || "360°-тур";
  scenes = [...manifest.scenes].sort((a, b) => a.order - b.order);
  if (!scenes.length) throw new Error("empty");
  topBar.hidden = false;
  if (manifest.features?.slideshow && scenes.length > 1) btnSlideshow.hidden = false;
  if (manifest.features?.lines && manifest.lines?.length) btnLines.hidden = false;
  if (scenes.some((sc) => sc.hotspots.some((h) => h.targetId))) btnSpots.hidden = false;
  lang = manifest.lang === "en" ? "en" : "ru";
  // Функция «Карта тура»: план — только если был загружен и функция была
  // включена на момент экспорта (manifest.mapImage, см. bundle.ts).
  if (manifest.mapImage) {
    mapImgEl.src = manifest.mapImage;
    mapMiniImg.src = manifest.mapImage;
    mapMini.hidden = false;
    renderMapPins();
  }
  // Брендинг тура: логотип (по умолчанию ZYXED) и подпись — всегда в манифесте (см. bundle.ts).
  const brand = manifest.branding;
  if (brand?.logo || brand?.text) {
    const el = document.createElement("div");
    el.className = "pano-brand";
    if (brand.logo) {
      const img = document.createElement("img");
      img.src = brand.logo;
      img.alt = "";
      el.appendChild(img);
    }
    if (brand.text) {
      const span = document.createElement("span");
      span.textContent = brand.text;
      el.appendChild(span);
    }
    wrapEl.appendChild(el);
  }
  goTo(0);
}

const embedded = readEmbeddedManifest();
if (embedded) {
  startTour(embedded);
} else {
  fetch("./data.json")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then(startTour)
    .catch(() => {
      veilText.textContent = "Не удалось загрузить данные тура (data.json).";
    });
}
