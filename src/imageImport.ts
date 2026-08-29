// Импорт панорам с телефона/компьютера.
// Всё делается в браузере: файлы не уходят никуда, только в IndexedDB.

import { loadBitmap, bitmapSize, closeBitmap, type Bitmap } from "./engine/bitmap";
export { loadBitmap, bitmapSize, closeBitmap };
export type { Bitmap };

const MAX_WIDTH = 4096; // шире хранить незачем — на экране разницы не видно
const THUMB_WIDTH = 480;
const NOTE_PHOTO_MAX_WIDTH = 1600; // фото в карточке заметки, не полноэкранная панорама
const LOGO_MAX_WIDTH = 240; // маленький водяной знак в углу плеера

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

// Функция «Сжатие панорам при импорте»: опциональные maxWidth/quality
// поверх дефолтных (MAX_WIDTH/0.9) — когда заданы явно, перекодируем даже
// снимок, который и без того уже был меньше предела, иначе выбор
// «Компактно» не давал бы эффекта на уже небольших исходниках.
export interface PrepareImageOptions {
  maxWidth?: number;
  quality?: number;
}

// Готовим файл к сохранению: уменьшаем гигантские снимки и делаем превью для списка.
export async function prepareImage(file: Blob, opts: PrepareImageOptions = {}): Promise<PreparedImage> {
  const bmp = await loadBitmap(file);
  const { width, height } = bitmapSize(bmp);
  if (!width || !height) {
    closeBitmap(bmp);
    throw new Error("Пустое изображение");
  }
  try {
    const thumbH = Math.max(1, Math.round((THUMB_WIDTH * height) / width));
    const thumb = await canvasToBlob(scaleTo(bmp, THUMB_WIDTH, thumbH), 0.75);
    const maxWidth = opts.maxWidth ?? MAX_WIDTH;
    const targetWidth = Math.min(width, maxWidth);
    if (targetWidth === width && opts.quality === undefined) return { image: file, thumb, width, height };
    const targetHeight = Math.max(1, Math.round((targetWidth * height) / width));
    const image = await canvasToBlob(scaleTo(bmp, targetWidth, targetHeight), opts.quality ?? 0.9);
    return { image, thumb, width: targetWidth, height: targetHeight };
  } finally {
    closeBitmap(bmp);
  }
}

// Фото для карточки богатой заметки (функция «Богатые заметки») — обычный
// снимок, не панорама, уменьшаем только если он реально огромный.
export async function prepareHotspotPhoto(file: Blob): Promise<Blob> {
  const bmp = await loadBitmap(file);
  const { width, height } = bitmapSize(bmp);
  if (!width || !height) {
    closeBitmap(bmp);
    throw new Error("Пустое изображение");
  }
  try {
    if (width <= NOTE_PHOTO_MAX_WIDTH) return file;
    const h = Math.max(1, Math.round((NOTE_PHOTO_MAX_WIDTH * height) / width));
    return await canvasToBlob(scaleTo(bmp, NOTE_PHOTO_MAX_WIDTH, h), 0.85);
  } finally {
    closeBitmap(bmp);
  }
}

// Логотип для функции «Брендинг тура» — маленькая картинка, храним как
// data: URI (в localStorage, см. src/branding.ts), не Blob. PNG — чтобы не
// потерять прозрачность фона у типичного логотипа.
export async function prepareBrandingLogo(file: Blob): Promise<string> {
  const bmp = await loadBitmap(file);
  const { width, height } = bitmapSize(bmp);
  if (!width || !height) {
    closeBitmap(bmp);
    throw new Error("Пустое изображение");
  }
  try {
    const w = Math.min(width, LOGO_MAX_WIDTH);
    const h = Math.max(1, Math.round((w * height) / width));
    return scaleTo(bmp, w, h).toDataURL("image/png");
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
