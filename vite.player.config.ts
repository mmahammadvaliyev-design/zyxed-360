import { defineConfig } from "vite";

// Отдельная сборка автономного плеера тура: без React и Dexie, только движок
// панорамы (src/engine) + рендер DOM руками. Результат кладём прямо в public/player,
// чтобы (а) он раздавался вместе с приложением для предпросмотра и (б) экспорт тура
// мог просто утянуть эти же готовые файлы в ZIP, ничего не компилируя на лету.
export default defineConfig({
  root: "player",
  base: "./",
  build: {
    outDir: "../public/player",
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
