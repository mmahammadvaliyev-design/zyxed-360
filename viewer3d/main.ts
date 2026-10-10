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
  ArrowHelper,
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
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
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

interface Mounted {
  dispose(): void;
}

interface MountOptions {
  lang?: "ru" | "en";
}

const STR = {
  ru: { measure: "📏 Замер", reset: "↺ Сброс", show: "Показ", modelIn: "Модель в", auto: "авто", scaleTitle: "Масштаб модели — если размеры сильно не те", tipOn: "Нажмите две точки на модели", tipOff: "", m: "м", cm: "см", mm: "мм", upZ: "↕ Вверх: Z", upY: "↕ Вверх: Y", upTitle: "Какая ось смотрит вверх. Меняется только вид — модель остаётся ровно как в файле", east: "В", north: "С" },
  en: { measure: "📏 Measure", reset: "↺ Reset", show: "Show", modelIn: "Model in", auto: "auto", scaleTitle: "Model scale — if the sizes are way off", tipOn: "Tap two points on the model", tipOff: "", m: "m", cm: "cm", mm: "mm", upZ: "↕ Up: Z", upY: "↕ Up: Y", upTitle: "Which axis points up. Only the view changes — the model stays exactly as in the file", east: "E", north: "N" },
};

// В чём показывать результат замера: «авто» — как удобнее по величине (мм до 1 м,
// иначе м); остальное — всегда в выбранных единицах.
type DisplayUnit = "auto" | "m" | "cm" | "mm";
const DISPLAY_UNITS: DisplayUnit[] = ["auto", "m", "cm", "mm"];

// Масштаб модели (единицы модели → метры). По спецификации glTF единица — метр
// (FBX приложение переводит в метры само), но чужие GLB иногда остаются в см или
// мм — для таких есть отдельная настройка за кнопкой ⚙.
const UNITS: { ru: string; en: string; toMeters: number }[] = [
  { ru: "м", en: "m", toMeters: 1 },
  { ru: "см", en: "cm", toMeters: 0.01 },
  { ru: "мм", en: "mm", toMeters: 0.001 },
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
.z3d-select{padding:0 6px;font-weight:500;width:auto;max-width:130px;flex:0 0 auto}
.z3d-select option{color:#14162a}
.z3d-tip{font:500 12px/1.2 system-ui,sans-serif;color:rgba(255,255,255,.75)}
.z3d-label{position:absolute;left:0;top:0;transform:translate(-50%,-130%);padding:3px 8px;border-radius:7px;background:rgba(255,211,78,.96);color:#14162a;font:700 12px/1.2 system-ui,sans-serif;white-space:nowrap;pointer-events:none;z-index:1}
.z3d-measuring canvas{cursor:crosshair}
.z3d-gizmo{position:absolute;z-index:2;pointer-events:none}
.z3d-gizmo-label{position:absolute;transform:translate(-50%,-50%);font:700 11px/1 system-ui,sans-serif;text-shadow:0 1px 3px #000,0 0 6px #000;white-space:nowrap}
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

function formatLength(meters: number, lang: "ru" | "en", unit: DisplayUnit): string {
  const s = STR[lang];
  const mm = meters * 1000;
  if (unit === "mm") return `${mm.toFixed(mm < 100 ? 1 : 0)} ${s.mm}`;
  if (unit === "cm") return `${(meters * 100).toFixed(1)} ${s.cm}`;
  if (unit === "m") return `${meters.toFixed(3)} ${s.m}`;
  if (meters < 1) return `${mm.toFixed(meters < 0.1 ? 1 : 0)} ${s.mm}`;
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
  // OrbitControls запоминает «вверх» при создании — при смене оси пересоздаём.
  const makeControls = () => {
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    return c;
  };
  let controls = makeControls();
  const Y_UP = new Vector3(0, 1, 0);
  const Z_UP = new Vector3(0, 0, 1);

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
  let displayUnit: DisplayUnit = "auto";
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
    label.textContent = formatLength(a.distanceTo(p) * toMeters, lang, displayUnit);
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
      m.label.textContent = formatLength(m.a.distanceTo(m.b) * toMeters, lang, displayUnit);
    }
  };

  // Панель в углу окна.
  const bar = document.createElement("div");
  bar.className = "z3d-bar";
  const btnMeasure = document.createElement("button");
  btnMeasure.className = "z3d-btn";
  btnMeasure.textContent = S.measure;
  const btnUp = document.createElement("button");
  btnUp.className = "z3d-btn";
  btnUp.title = S.upTitle;
  const refreshUpBtn = () => {
    btnUp.textContent = camera.up.z > 0.5 ? S.upZ : S.upY;
  };
  const applyUp = (u: Vector3) => {
    camera.up.copy(u);
    controls.dispose();
    controls = makeControls();
    if (model) fit(model);
    rebuildGizmo();
    refreshUpBtn();
  };
  btnUp.addEventListener("click", () => applyUp(camera.up.z > 0.5 ? Y_UP : Z_UP));
  const btnReset = document.createElement("button");
  btnReset.className = "z3d-btn";
  btnReset.textContent = S.reset;
  btnReset.hidden = true;
  // «Показ»: в чём выводить результат (авто / м / см / мм).
  const unitSelect = document.createElement("select");
  unitSelect.className = "z3d-select";
  unitSelect.title = S.show;
  DISPLAY_UNITS.forEach((u) => {
    const o = document.createElement("option");
    o.value = u;
    o.textContent = `${S.show}: ${u === "auto" ? S.auto : S[u]}`;
    unitSelect.appendChild(o);
  });
  unitSelect.hidden = true;
  // «⚙»: масштаб модели — для моделей, где размеры сильно не те (см/мм вместо метров).
  const btnScale = document.createElement("button");
  btnScale.className = "z3d-btn";
  btnScale.textContent = "⚙";
  btnScale.title = S.scaleTitle;
  btnScale.hidden = true;
  const scaleSelect = document.createElement("select");
  scaleSelect.className = "z3d-select";
  scaleSelect.title = S.scaleTitle;
  UNITS.forEach((u, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${S.modelIn}: ${lang === "en" ? u.en : u.ru}`;
    scaleSelect.appendChild(o);
  });
  scaleSelect.hidden = true;
  const tip = document.createElement("span");
  tip.className = "z3d-tip";
  bar.append(btnMeasure, btnUp, btnReset, unitSelect, btnScale, scaleSelect, tip);
  container.appendChild(bar);

  btnMeasure.addEventListener("click", () => {
    measureOn = !measureOn;
    btnMeasure.classList.toggle("on", measureOn);
    container.classList.toggle("z3d-measuring", measureOn);
    btnReset.hidden = !measureOn;
    unitSelect.hidden = !measureOn;
    btnScale.hidden = !measureOn;
    if (!measureOn) scaleSelect.hidden = true;
    tip.textContent = measureOn ? S.tipOn : S.tipOff;
    if (!measureOn) clearMeasurements();
  });
  btnReset.addEventListener("click", clearMeasurements);
  // Подписи обновляем сразу при выборе, не дожидаясь следующего кадра.
  unitSelect.addEventListener("change", () => {
    displayUnit = (unitSelect.value as DisplayUnit) || "auto";
    updateLabels();
  });
  btnScale.addEventListener("click", () => {
    scaleSelect.hidden = !scaleSelect.hidden;
    btnScale.classList.toggle("on", !scaleSelect.hidden);
  });
  scaleSelect.addEventListener("change", () => {
    toMeters = UNITS[Number(scaleSelect.value)]?.toMeters ?? 1;
    updateLabels();
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

  // ——— оси и север ———
  // Уголок с осями X/Y/Z, вращающийся вместе с камерой. По CAD-соглашению
  // +X — восток, +Y — север, +Z — вверх; для моделей с осью «вверх = Y»
  // север откладывается по −Z (так он оказывается при обычном Z-up → Y-up).
  const GIZMO_X = 10;
  const GIZMO_Y = 34;
  let gizmoPx = 96;
  const gizmoScene = new Scene();
  const gizmoCam = new PerspectiveCamera(30, 1, 0.1, 30);
  const gizmoBox = document.createElement("div");
  gizmoBox.className = "z3d-gizmo";
  container.appendChild(gizmoBox);
  const gizmoLabels: { el: HTMLDivElement; dir: Vector3 }[] = [];
  const gizmoArrows: ArrowHelper[] = [];
  // Пометка «вверх» из файла (FBX, переведённый приложением): модель в системе CAD,
  // оси подписываем как есть. Без пометки (обычный GLB, Y-up) оси рисуем по правилам
  // CAD: вертикаль = Z, север = Y (в GLB это −Z), восток = X — как на самой модели.
  let modelHint: string | undefined;
  const rebuildGizmo = () => {
    for (const a of gizmoArrows) {
      gizmoScene.remove(a);
      a.dispose();
    }
    gizmoArrows.length = 0;
    for (const l of gizmoLabels) l.el.remove();
    gizmoLabels.length = 0;
    const add = (dir: Vector3, color: number, text: string, len = 1) => {
      const d = dir.clone().normalize();
      const arrow = new ArrowHelper(d, new Vector3(), len, color, 0.28, 0.16);
      gizmoScene.add(arrow);
      gizmoArrows.push(arrow);
      const el = document.createElement("div");
      el.className = "z3d-gizmo-label";
      el.textContent = text;
      el.style.color = "#" + color.toString(16).padStart(6, "0");
      gizmoBox.appendChild(el);
      gizmoLabels.push({ el, dir: d.multiplyScalar(len) });
    };
    const cadMapped = camera.up.z <= 0.5 && !modelHint;
    add(new Vector3(1, 0, 0), 0xff5a5a, `X · ${S.east}`);
    if (cadMapped) {
      add(new Vector3(0, 0, -1), 0x5adf7a, `Y · ${S.north}`);
      add(new Vector3(0, 1, 0), 0x5a9bff, "Z");
    } else {
      add(new Vector3(0, 1, 0), 0x5adf7a, `Y · ${S.north}`);
      add(new Vector3(0, 0, 1), 0x5a9bff, "Z");
    }
  };
  const layoutGizmo = () => {
    gizmoPx = (container.clientWidth || 600) < 520 ? 76 : 96;
    gizmoBox.style.left = `${GIZMO_X}px`;
    gizmoBox.style.bottom = `${GIZMO_Y}px`;
    gizmoBox.style.width = `${gizmoPx}px`;
    gizmoBox.style.height = `${gizmoPx}px`;
  };

  // ——— камера и цикл отрисовки ———
  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    layoutGizmo();
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
    // уголок с осями — отдельным проходом в углу, поверх модели
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setViewport(GIZMO_X, GIZMO_Y, gizmoPx, gizmoPx);
    renderer.setScissor(GIZMO_X, GIZMO_Y, gizmoPx, gizmoPx);
    gizmoCam.position.copy(camera.position).sub(controls.target).setLength(4.6);
    gizmoCam.up.copy(camera.up);
    gizmoCam.lookAt(0, 0, 0);
    renderer.render(gizmoScene, gizmoCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, container.clientWidth || 1, container.clientHeight || 1);
    renderer.autoClear = true;
    for (const l of gizmoLabels) {
      const v = l.dir.clone().multiplyScalar(1.22).project(gizmoCam);
      l.el.style.left = `${(v.x * 0.5 + 0.5) * gizmoPx}px`;
      l.el.style.top = `${(0.5 - v.y * 0.5) * gizmoPx}px`;
    }
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
    if (camera.up.z > 0.5) camera.position.set(center.x + dist * 0.6, center.y - dist * 0.75, center.z + dist * 0.45);
    else camera.position.set(center.x + dist * 0.6, center.y + dist * 0.45, center.z + dist * 0.75);
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
        // Модель из CAD (FBX, переведённый приложением) помечена осью «вверх» —
        // показываем её «стоя», при этом сами данные не меняются.
        let hintUp: string | undefined;
        model.traverse((o) => {
          const u = (o.userData as { zyxedUp?: string }).zyxedUp;
          if (u && !hintUp) hintUp = u;
        });
        modelHint = hintUp;
        if (hintUp === "z") applyUp(Z_UP);
        else {
          rebuildGizmo();
          refreshUpBtn();
          fit(model);
        }
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
      for (const a of gizmoArrows) a.dispose();
      gizmoBox.remove();
      if (model) disposeObject(model);
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

// ── FBX → GLB ────────────────────────────────────────────────────────────
// Нужен редактору: пользователь прикрепляет FBX (из Navisworks/Plant 3D и т.п.),
// а в туре показывается только GLB. Единицы приводятся к метрам по
// UnitScaleFactor из файла (1 = сантиметры, 100 = метры): GLB по спецификации
// в метрах, а замер в просмотрщике считает именно так. Материалы FBX
// (Phong/Lambert) переводятся в стандартные — иначе цвет теряется при экспорте.
function toStandardMaterials(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!(m as unknown as { isMesh?: boolean }).isMesh) return;
    const conv = (mat: Material): Material => {
      const a = mat as unknown as { isMeshStandardMaterial?: boolean; color?: { clone(): unknown }; map?: Texture | null; opacity?: number; transparent?: boolean; side?: number; name?: string };
      if (a.isMeshStandardMaterial) return mat;
      const s = new MeshStandardMaterial({
        color: (a.color ?? 0xcccccc) as never,
        map: a.map ?? null,
        opacity: a.opacity ?? 1,
        transparent: !!a.transparent,
        side: (a.side ?? 0) as never,
        roughness: 0.65,
        metalness: 0.1,
      });
      s.name = a.name ?? "";
      mat.dispose();
      return s;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
}

// Ось «вверх», записанная в FBX (GlobalSettings: UpAxis 0/1/2 = X/Y/Z и UpAxisSign).
// CAD (Plant 3D, Navisworks, Revit, 3ds Max) обычно Z-up, а glTF и наш
// просмотрщик — Y-up; FBXLoader оси не пересчитывает, поэтому без поворота
// модель оказывалась лежащей на боку. Читаем напрямую из байтов файла —
// и для бинарного, и для текстового FBX.
function readFbxUp(data: ArrayBuffer): { axis: number; sign: number } | null {
  const b = new Uint8Array(data);
  const dv = new DataView(data);
  const find = (needle: Uint8Array, from = 0): number => {
    outer: for (let i = from; i <= b.length - needle.length; i++) {
      for (let k = 0; k < needle.length; k++) if (b[i + k] !== needle[k]) continue outer;
      return i;
    }
    return -1;
  };
  const enc = (s: string) => new TextEncoder().encode(s);
  const isBinary = new TextDecoder("latin1").decode(b.subarray(0, 20)).startsWith("Kaydara FBX Binary");
  const readProp = (name: string): number | null => {
    if (isBinary) {
      // свойство P: строки name,type,label,flags (каждая: 'S' + uint32 длина + байты), затем 'I' + int32
      const key = enc(name);
      const needle = new Uint8Array(1 + 4 + key.length);
      needle[0] = 0x53;
      new DataView(needle.buffer).setUint32(1, key.length, true);
      needle.set(key, 5);
      let p = find(needle);
      if (p < 0) return null;
      for (let s = 0; s < 4; s++) {
        if (b[p] !== 0x53) return null;
        p += 1 + 4 + dv.getUint32(p + 1, true);
      }
      return b[p] === 0x49 ? dv.getInt32(p + 1, true) : null;
    }
    const text = new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 200000)));
    const m = new RegExp(`"${name}"\\s*,\\s*"int"\\s*,\\s*"Integer"\\s*,\\s*"[^"]*"\\s*,\\s*(-?\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const axis = readProp("UpAxis");
  if (axis === null || axis < 0 || axis > 2) return null;
  const sign = readProp("UpAxisSign");
  return { axis, sign: sign === -1 ? -1 : 1 };
}

async function convertFbx(
  data: ArrayBuffer,
): Promise<{ glb: ArrayBuffer; info: { meshes: number; tris: number; sizeM: [number, number, number] } }> {
  const root = new FBXLoader().parse(data, "");
  const unit = (root.userData as { unitScaleFactor?: number }).unitScaleFactor;
  if (typeof unit === "number" && unit > 0) root.scale.multiplyScalar(unit * 0.01);
  // Геометрию НЕ поворачиваем и не зеркалим: направление и наклон труб остаются
  // ровно такими, как в исходном файле. Ось «вверх» только записываем в файл
  // (extras) — по ней просмотрщик показывает модель «стоя».
  const up = readFbxUp(data);
  if (up && !(up.axis === 1 && up.sign === 1)) {
    (root.userData as Record<string, unknown>).zyxedUp = (up.sign < 0 ? "-" : "") + "xyz"[up.axis];
  }
  root.updateMatrixWorld(true);
  toStandardMaterials(root);
  // FBXLoader отдаёт геометрию без общих вершин (каждый треугольник со своими) —
  // объединяем одинаковые: форма и положение вершин те же (допуск 1e-6 м), файл
  // получается в 2–3 раза меньше. Нормали/UV при этом сохраняются как есть.
  root.traverse((o) => {
    const m = o as Mesh;
    if ((m as unknown as { isMesh?: boolean }).isMesh) {
      const old = m.geometry;
      m.geometry = mergeVertices(old, 1e-6);
      old.dispose();
    }
  });
  let meshes = 0;
  let tris = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if ((m as unknown as { isMesh?: boolean }).isMesh) {
      meshes++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  if (!meshes) throw new Error("В файле нет геометрии");
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const glb = await new Promise<ArrayBuffer>((resolve, reject) =>
    new GLTFExporter().parse(root, (r) => resolve(r as ArrayBuffer), (e) => reject(e), { binary: true, maxTextureSize: 2048 }),
  );
  disposeObject(root);
  return { glb, info: { meshes, tris: Math.round(tris), sizeM: [size.x, size.y, size.z] } };
}

(window as unknown as { Zyxed3D: unknown }).Zyxed3D = { mount, convertFbx };
