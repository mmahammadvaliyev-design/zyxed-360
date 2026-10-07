// Подключает 3D-просмотрщик по требованию: код лежит в приложении строкой
// (src/export/viewer3dAsset.generated.ts) и выполняется как <script> только
// при первом открытии модели — так приложение работает и под file://, где нет
// ни fetch, ни динамических import.
import { VIEWER3D_JS } from "./export/viewer3dAsset.generated";
import type { Viewer3dApi } from "./engine/files";

export function loadViewer3d(): Promise<Viewer3dApi> {
  if (!window.Zyxed3D) {
    const script = document.createElement("script");
    script.textContent = VIEWER3D_JS;
    document.head.appendChild(script);
    script.remove();
  }
  return window.Zyxed3D ? Promise.resolve(window.Zyxed3D) : Promise.reject(new Error("3D viewer failed to initialise"));
}
