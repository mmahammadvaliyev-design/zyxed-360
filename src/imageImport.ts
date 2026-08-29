// Импорт панорам с телефона/компьютера и генератор демо-панорам.
// Всё делается в браузере: файлы не уходят никуда, только в IndexedDB.

import { loadBitmap, bitmapSize, closeBitmap, type Bitmap } from "./engine/bitmap";
export { loadBitmap, bitmapSize, closeBitmap };
export type { Bitmap };

const MAX_WIDTH = 4096; // шире хранить незачем — на экране разницы не видно
const THUMB_WIDTH = 480;

export interface PreparedImage {
  image: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось сохранить изображение"))), "image/jpeg", quality);
  });
}

function scaleTo(src: Bitmap, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src as CanvasImageSource, 0, 0, width, height);
  return canvas;
}

// Готовим файл к сохранению: уменьшаем гигантские снимки и делаем превью для списка.
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bmp = await loadBitmap(file);
  const { width, height } = bitmapSize(bmp);
  if (!width || !height) {
    closeBitmap(bmp);
    throw new Error("Пустое изображение");
  }
  try {
    const thumbH = Math.max(1, Math.round((THUMB_WIDTH * height) / width));
    const thumb = await canvasToBlob(scaleTo(bmp, THUMB_WIDTH, thumbH), 0.75);
    if (width <= MAX_WIDTH) return { image: file, thumb, width, height };
    const h = Math.max(1, Math.round((MAX_WIDTH * height) / width));
    const image = await canvasToBlob(scaleTo(bmp, MAX_WIDTH, h), 0.9);
    return { image, thumb, width: MAX_WIDTH, height: h };
  } finally {
    closeBitmap(bmp);
  }
}

// Панорама «правильная», если ширина ровно вдвое больше высоты (equirectangular 2:1).
export function ratioHint(width: number, height: number): string | null {
  const r = width / height;
  if (r > 1.9 && r < 2.1) return null;
  return `Пропорции ${width}×${height} (${r.toFixed(2)}:1) — для полной сферы нужно 2:1, иначе картинка растянется.`;
}

// ── Демо-тур ──────────────────────────────────────────────────────
export interface DemoPreset {
  title: string;
  sky: [string, string];
  ground: [string, string];
  accent: string;
  sunPitch: number;
}

export const DEMO_PRESETS: DemoPreset[] = [
  { title: "Рассвет", sky: ["#1b2a6b", "#f6b48a"], ground: ["#2c2f52", "#12142b"], accent: "#ffd6a5", sunPitch: 6 },
  { title: "Полдень", sky: ["#1f7ae0", "#cfe9ff"], ground: ["#2f7d4f", "#123a24"], accent: "#ffffff", sunPitch: 42 },
  { title: "Ночь", sky: ["#05070f", "#1b2450"], ground: ["#161a30", "#080a16"], accent: "#a5b4fc", sunPitch: 28 },
];

const DEMO_W = 2048;
const DEMO_H = 1024;
const xFor = (lonDeg: number) => ((lonDeg + 180) / 360) * DEMO_W;
const yFor = (latDeg: number) => ((90 - latDeg) / 180) * DEMO_H;

export async function makeDemoPanorama(preset: DemoPreset): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = DEMO_W;
  canvas.height = DEMO_H;
  const ctx = canvas.getContext("2d")!;
  const horizon = yFor(0);

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, preset.sky[0]);
  sky.addColorStop(1, preset.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, DEMO_W, horizon);

  const ground = ctx.createLinearGradient(0, horizon, 0, DEMO_H);
  ground.addColorStop(0, preset.ground[0]);
  ground.addColorStop(1, preset.ground[1]);
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizon, DEMO_W, DEMO_H - horizon);

  if (preset.title === "Ночь") {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * DEMO_W;
      const y = Math.random() * horizon * 0.92;
      const r = Math.random() * 1.6 + 0.3;
      ctx.globalAlpha = 0.25 + Math.random() * 0.75;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const sunX = xFor(35);
  const sunY = yFor(preset.sunPitch);
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 260);
  glow.addColorStop(0, preset.accent);
  glow.addColorStop(0.12, preset.accent);
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(sunX, sunY, 260, 0, Math.PI * 2);
  ctx.fill();

  const ridge = (amp: number, color: string, phase: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, DEMO_H);
    for (let x = 0; x <= DEMO_W; x += 4) {
      const t = (x / DEMO_W) * Math.PI * 2;
      const h = Math.sin(t * 3 + phase) * amp + Math.sin(t * 5 + phase * 1.7) * amp * 0.45 + Math.sin(t * 11 + phase * 0.6) * amp * 0.18;
      ctx.lineTo(x, horizon - h);
    }
    ctx.lineTo(DEMO_W, DEMO_H);
    ctx.closePath();
    ctx.fill();
  };
  ridge(70, "rgba(0,0,0,0.22)", 0.4);
  ridge(44, "rgba(0,0,0,0.34)", 2.1);

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  for (let lon = -180; lon < 180; lon += 15) {
    ctx.beginPath();
    ctx.moveTo(xFor(lon), horizon);
    ctx.lineTo(xFor(lon), DEMO_H);
    ctx.stroke();
  }
  for (const lat of [-10, -20, -35, -55]) {
    ctx.beginPath();
    ctx.moveTo(0, yFor(lat));
    ctx.lineTo(DEMO_W, yFor(lat));
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(DEMO_W, horizon);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 46px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  const marks: [number, string][] = [[0, "СЕВЕР"], [90, "ВОСТОК"], [180, "ЮГ"], [-90, "ЗАПАД"]];
  for (const [lon, label] of marks) ctx.fillText(label, xFor(lon), yFor(-6));

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "bold 96px system-ui, sans-serif";
  ctx.fillText(preset.title.toUpperCase(), xFor(0), yFor(18));
  ctx.font = "30px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText("демо-панорама Zyxed 360", xFor(0), yFor(11));

  return canvasToBlob(canvas, 0.9);
}
