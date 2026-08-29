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
import type { Hotspot, SceneMeta, TourManifest } from "../src/engine/types";

const ROTATE_SPEED = rad(9);
const FRICTION = 6;
const TAP_SLOP = 8;

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="pano-wrap" id="wrap">
    <canvas class="pano-canvas" id="canvas"></canvas>
    <div class="pano-veil on" id="veil"><div class="pano-loader" id="veil-text">Загружаю тур…</div></div>
    <div class="pano-top" data-hud id="top" hidden>
      <div class="pano-title"><b id="title"></b><span class="pano-sub" id="sub"></span></div>
      <div class="pano-tools">
        <button class="pano-btn" id="btn-rotate" title="Автоповорот">↻</button>
        <button class="pano-btn" id="btn-gyro" title="Поворот по наклону телефона" hidden>🧭</button>
        <button class="pano-btn" id="btn-fs" title="Во весь экран" hidden>⤢</button>
      </div>
    </div>
    <div class="pano-strip" data-hud id="strip" hidden></div>
    <div class="pano-toast" id="toast" hidden></div>
  </div>
`;

const wrapEl = document.getElementById("wrap")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const veil = document.getElementById("veil")!;
const veilText = document.getElementById("veil-text")!;
const topBar = document.getElementById("top")!;
const titleEl = document.getElementById("title")!;
const subEl = document.getElementById("sub")!;
const stripEl = document.getElementById("strip")!;
const toastEl = document.getElementById("toast")!;
const btnRotate = document.getElementById("btn-rotate") as HTMLButtonElement;
const btnGyro = document.getElementById("btn-gyro") as HTMLButtonElement;
const btnFs = document.getElementById("btn-fs") as HTMLButtonElement;

// Без этого клик по кнопкам интерфейса перехватывается жестом на панораме:
// wrapEl.setPointerCapture() ниже переносит последующий click на себя же,
// если pointerdown успел всплыть досюда.
topBar.addEventListener("pointerdown", (e) => e.stopPropagation());
stripEl.addEventListener("pointerdown", (e) => e.stopPropagation());

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
const pointers = new Map<number, { x: number; y: number }>();
const drag = { active: false, x: 0, y: 0, moved: 0, pinch: 0 };
let downTarget: HTMLElement | null = null;
let loadToken = 0;

function currentScene(): SceneMeta | undefined {
  return scenes[currentIndex];
}

function pinchDistance(): number {
  const pts = [...pointers.values()];
  if (pts.length < 2) return 0;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

const SPOT_ICON_LINK =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M8 5l8 7-8 7" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SPOT_ICON_NOTE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#fff" stroke-width="2"/><line x1="12" y1="11" x2="12" y2="16" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="8" r="1.15" fill="#fff"/></svg>';

function renderHotspots(scene: SceneMeta) {
  hotspotEls.forEach((el) => el.remove());
  hotspotEls.clear();
  for (const h of scene.hotspots) {
    const btn = document.createElement("button");
    btn.className = `pano-spot${h.targetId ? "" : " note"}`;
    btn.dataset.hud = "1";
    btn.dataset.spot = h.id;
    btn.style.visibility = "hidden";
    btn.title = h.label;
    btn.innerHTML = `<span class="pano-spot-dot">${h.targetId ? SPOT_ICON_LINK : SPOT_ICON_NOTE}</span><span class="pano-spot-label"></span>`;
    (btn.querySelector(".pano-spot-label") as HTMLElement).textContent = h.label;
    btn.addEventListener("click", (e) => {
      if ((e as MouseEvent).detail === 0) activateHotspot(h);
    });
    wrapEl.appendChild(btn);
    hotspotEls.set(h.id, btn);
  }
}

function activateHotspot(h: Hotspot) {
  if (h.targetId) {
    const idx = scenes.findIndex((s) => s.id === h.targetId);
    if (idx >= 0) {
      goTo(idx);
      return;
    }
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

async function goTo(index: number) {
  currentIndex = index;
  const scene = scenes[index];
  if (!scene) return;
  const token = ++loadToken;

  titleEl.textContent = scene.title;
  subEl.textContent = `${index + 1} / ${scenes.length}`;
  renderHotspots(scene);
  renderStrip();

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
  wrapEl.setPointerCapture?.(e.pointerId);
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
  if (drag.moved < TAP_SLOP) handleTap(downTarget);
}
wrapEl.addEventListener("pointerup", onPointerUp);
wrapEl.addEventListener("pointercancel", onPointerUp);

function handleTap(target: HTMLElement | null) {
  const spot = target?.closest<HTMLElement>("[data-spot]");
  if (spot) {
    const h = currentScene()?.hotspots.find((x) => x.id === spot.dataset.spot);
    if (h) activateHotspot(h);
  }
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
  if (e.key.startsWith("Arrow")) {
    keys.add(e.key);
    e.preventDefault();
  }
  if (e.key === "+" || e.key === "=") view.fov = clamp(view.fov / 1.15, MIN_FOV, MAX_FOV);
  if (e.key === "-") view.fov = clamp(view.fov * 1.15, MIN_FOV, MAX_FOV);
});
window.addEventListener("keyup", (e) => keys.delete(e.key));

btnRotate.addEventListener("click", () => {
  autorotate = !autorotate;
  if (autorotate) { gyroOn = false; btnGyro.classList.remove("on"); }
  btnRotate.classList.toggle("on", autorotate);
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
