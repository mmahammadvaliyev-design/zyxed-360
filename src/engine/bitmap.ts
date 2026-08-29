// Декодирование Blob → битмап для WebGL-текстуры. Без React — общее для
// приложения (импорт своих снимков) и автономного плеера (загрузка из ZIP).
export type Bitmap = ImageBitmap | HTMLImageElement;

export async function loadBitmap(blob: Blob): Promise<Bitmap> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* старые браузеры и нестандартные jpeg — падаем на <img> ниже */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function bitmapSize(b: Bitmap): { width: number; height: number } {
  return b instanceof HTMLImageElement
    ? { width: b.naturalWidth, height: b.naturalHeight }
    : { width: b.width, height: b.height };
}

export function closeBitmap(b: Bitmap): void {
  if ("close" in b && typeof b.close === "function") b.close();
}
