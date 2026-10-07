// Просмотр 3D-модели (.glb) внутри карточки заметки. Собирается отдельно
// (vite.viewer3d.config.ts → IIFE) и подключается только там, где реально
// есть модель: three.js тяжёлый, плеер обычного тура ради него раздувать
// незачем. Подключается как обычный classic <script> (под file:// модули
// не грузятся) и вешает на window единственную функцию Zyxed3D.mount.
//
// Внутри — и сам просмотр (орбитальная камера), и замер расстояний: кнопка
// «Замер» на панели в углу окна, две точки на модели → расстояние. Панель
// и подписи строятся здесь же, чтобы и приложение, и плеер тура получали их
// без дублирования кода.
import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

interface Mounted {
  dispose(): void;
}

interface MountOptions {
  lang?: "ru" | "en";
}

const STR = {
  ru: { measure: "📏 Замер", reset: "↺ Сброс", units: "Ед.", tipOn: "Нажмите две точки на модели", tipOff: "", m: "м", mm: "мм" },
  en: { measure: "📏 Measure", reset: "↺ Reset", units: "Units", tipOn: "Tap two points on the model", tipOff: "", m: "m", mm: "mm" },
};

// Единицы модели → метры. По спецификации glTF единица — метр, но модели,
// сконвертированные из CAD/Navisworks, нередко остаются в см или мм.
const UNITS: { label: string; toMeters: number }[] = [
  { label: "м / m", toMeters: 1 },
  { label: "см / cm", toMeters: 0.01 },
  { label: "мм / mm", toMeters: 0.001 },
];

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.z3d-bar{position:absolute;left:10px;top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;z-index:2;max-width:calc(100% - 20px)}
.z3d-btn,.z3d-select{height:32px;padding:0 11px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(8,14,24,.72);color:#fff;font:600 13px/1 system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(6px)}
.z3d-btn.on{background:#fff;color:#0a1420;border-color:#fff}
.z3d-select{padding:0 6px;font-weight:500}
.z3d-select option{color:#14162a}
.z3d-tip{font:500 12px/1.2 system-ui,sans-serif;color:rgba(255,255,255,.75)}
.z3d-label{position:absolute;left:0;top:0;transform:translate(-50%,-130%);padding:3px 8px;border-radius:7px;background:rgba(255,211,78,.96);color:#14162a;font:700 12px/1.2 system-ui,sans-serif;white-space:nowrap;pointer-events:none;z-index:1}
.z3d-measuring canvas{cursor:crosshair}
`;
  document.head.appendChild(style);
}

function disposeObject(root: Object3D) {
  root.traverse((o) => {
    const mesh = o as unknown as { geometry?: { dispose(): void }; material?: Material | Material[] };
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        if (v && (v as Texture).isTexture) (v as Texture).dispose();
      }
      m.dispose();
    }
  });
}

function formatLength(meters: number, lang: "ru" | "en"): string {
  const s = STR[lang];
  if (meters < 1) return `${(meters * 1000).toFixed(meters < 0.1 ? 1 : 0)} ${s.mm}`;
  return `${meters.toFixed(meters < 100 ? 2 : 1)} ${s.m}`;
}

interface Measurement {
  a: Vector3;
  b: Vector3;
  label: HTMLDivElement;
}

function mount(
  container: HTMLElement,
  data: ArrayBuffer,
  onError: (message: string) => void,
  onReady?: () => void,
  opts: MountOptions = {},
): Mounted {
  const lang = opts.lang === "en" ? "en" : "ru";
  const S = STR[lang];
  injectStyle();

  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;outline:none";
  container.appendChild(canvas);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;

  const camera = new PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  let disposed = false;
  let raf = 0;
  let model: Object3D | null = null;
  let markerRadius = 0.01;

  // ——— замер ———
  const measureGroup = new Group();
  scene.add(measureGroup);
  const measurements: Measurement[] = [];
  let pending: { point: Vector3; marker: Mesh } | null = null;
  let measureOn = false;
  let toMeters = 1;
  const raycaster = new Raycaster();

  const lineMat = new LineBasicMaterial({ color: 0xffd34e, depthTest: false, transparent: true });
  const markerMat = new MeshBasicMaterial({ color: 0xffd34e, depthTest: false, transparent: true });

  const addMarker = (p: Vector3): Mesh => {
    const m = new Mesh(new SphereGeometry(markerRadius, 12, 12), markerMat);
    m.position.copy(p);
    m.renderOrder = 1000;
    measureGroup.add(m);
    return m;
  };

  const clearMeasurements = () => {
    for (const m of measurements) m.label.remove();
    measurements.length = 0;
    pending = null;
    for (const child of [...measureGroup.children]) {
      measureGroup.remove(child);
      const g = (child as unknown as { geometry?: { dispose(): void } }).geometry;
      g?.dispose();
    }
  };

  const pickPoint = (clientX: number, clientY: number): Vector3 | null => {
    if (!model) return null;
    const rect = canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(model, true)[0];
    return hit ? hit.point.clone() : null;
  };

  const placePoint = (p: Vector3) => {
    if (!pending) {
      pending = { point: p, marker: addMarker(p) };
      return;
    }
    const a = pending.point;
    addMarker(p);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute([a.x, a.y, a.z, p.x, p.y, p.z], 3));
    const line = new Line(geo, lineMat);
    line.renderOrder = 999;
    measureGroup.add(line);
    const label = document.createElement("div");
    label.className = "z3d-label";
    container.appendChild(label);
    measurements.push({ a, b: p, label });
    pending = null;
  };

  // Подписи — HTML поверх канваса; каждый кадр переставляем к проекции
  // середины отрезка и прячем, если отрезок за камерой.
  const tmp = new Vector3();
  const updateLabels = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    for (const m of measurements) {
      tmp.copy(m.a).add(m.b).multiplyScalar(0.5).project(camera);
      if (tmp.z > 1) {
        m.label.style.display = "none";
        continue;
      }
      m.label.style.display = "";
      m.label.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`;
      m.label.style.top = `${(-tmp.y * 0.5 + 0.5) * h}px`;
      m.label.textContent = formatLength(m.a.distanceTo(m.b) * toMeters, lang);
    }
  };

  // Панель в углу окна.
  const bar = document.createElement("div");
  bar.className = "z3d-bar";
  const btnMeasure = document.createElement("button");
  btnMeasure.className = "z3d-btn";
  btnMeasure.textContent = S.measure;
  const btnReset = document.createElement("button");
  btnReset.className = "z3d-btn";
  btnReset.textContent = S.reset;
  btnReset.hidden = true;
  const unitSelect = document.createElement("select");
  unitSelect.className = "z3d-select";
  unitSelect.title = S.units;
  UNITS.forEach((u, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${S.units}: ${u.label}`;
    unitSelect.appendChild(o);
  });
  unitSelect.hidden = true;
  const tip = document.createElement("span");
  tip.className = "z3d-tip";
  bar.append(btnMeasure, btnReset, unitSelect, tip);
  container.appendChild(bar);

  btnMeasure.addEventListener("click", () => {
    measureOn = !measureOn;
    btnMeasure.classList.toggle("on", measureOn);
    container.classList.toggle("z3d-measuring", measureOn);
    btnReset.hidden = !measureOn;
    unitSelect.hidden = !measureOn;
    tip.textContent = measureOn ? S.tipOn : S.tipOff;
    if (!measureOn) clearMeasurements();
  });
  btnReset.addEventListener("click", clearMeasurements);
  unitSelect.addEventListener("change", () => {
    toMeters = UNITS[Number(unitSelect.value)]?.toMeters ?? 1;
  });

  // Тап (а не перетаскивание/щипок) по модели в режиме замера — ставит точку.
  let down: { x: number; y: number; t: number } | null = null;
  let multiTouch = false;
  const activePointers = new Set<number>();
  const onPointerDown = (e: PointerEvent) => {
    activePointers.add(e.pointerId);
    if (activePointers.size > 1) multiTouch = true;
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onPointerUp = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    const d = down;
    if (activePointers.size === 0) {
      const cancelled = multiTouch;
      multiTouch = false;
      down = null;
      if (!measureOn || cancelled || !d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 6 || performance.now() - d.t > 600) return;
      const p = pickPoint(e.clientX, e.clientY);
      if (p) placePoint(p);
    }
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", () => {
    activePointers.clear();
    multiTouch = false;
    down = null;
  });

  // ——— камера и цикл отрисовки ———
  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const loop = () => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
    updateLabels();
  };

  const fit = (obj: Object3D) => {
    const box = new Box3().setFromObject(obj);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.7;
    camera.near = maxDim / 200;
    camera.far = maxDim * 200;
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.45, center.z + dist * 0.75);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = maxDim * 0.05;
    controls.maxDistance = maxDim * 20;
    controls.update();
    markerRadius = maxDim * 0.008;
  };

  try {
    new GLTFLoader().parse(
      data,
      "",
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        model = gltf.scene;
        scene.add(model);
        fit(model);
        loop();
        onReady?.();
      },
      (err) => onError(err instanceof Error ? err.message : String(err)),
    );
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      clearMeasurements();
      lineMat.dispose();
      markerMat.dispose();
      bar.remove();
      if (model) disposeObject(model);
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

(window as unknown as { Zyxed3D: unknown }).Zyxed3D = { mount };
