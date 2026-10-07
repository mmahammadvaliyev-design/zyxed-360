// Просмотр 3D-модели (.glb) внутри карточки заметки. Собирается отдельно
// (vite.viewer3d.config.ts → IIFE) и подключается только там, где реально
// есть модель: three.js тяжёлый, плеер обычного тура ради него раздувать
// незачем. Подключается как обычный classic <script> (под file:// модули
// не грузятся) и вешает на window единственную функцию Zyxed3D.mount.
import {
  Box3,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

interface Mounted {
  dispose(): void;
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

function mount(container: HTMLElement, data: ArrayBuffer, onError: (message: string) => void, onReady?: () => void): Mounted {
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
