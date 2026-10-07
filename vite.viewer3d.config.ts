import { defineConfig } from "vite";

// Отдельная сборка 3D-просмотрщика (viewer3d/main.ts) в один IIFE-файл без
// модулей: его читает scripts/gen-viewer3d-asset.mjs и встраивает строкой в
// приложение (чтобы и приложение, и экспорт тура подключали его как обычный
// <script> — под file:// ни fetch, ни module-скрипты не работают).
export default defineConfig({
  build: {
    outDir: "build-viewer3d",
    emptyOutDir: true,
    lib: { entry: "viewer3d/main.ts", name: "Zyxed3DBundle", formats: ["iife"], fileName: () => "viewer3d.js" },
    minify: "esbuild",
  },
});
