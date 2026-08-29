// QR-код тура: генерируется целиком в браузере (пакет qrcode — чистый
// алгоритм, без сети), вставляете ссылку на уже опубликованный тур —
// получаете картинку для печати в отчёте или на объекте.
import QRCode from "qrcode";

export async function renderQrToCanvas(canvas: HTMLCanvasElement, url: string): Promise<void> {
  await QRCode.toCanvas(canvas, url, { width: 240, margin: 2, color: { dark: "#04080f", light: "#ffffff" } });
}
