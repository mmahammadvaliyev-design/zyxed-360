import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Плеер собирается отдельным шагом (npm run build:player) прямо в public/player,
// поэтому здесь он просто копируется как статика вместе с остальным public/.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
