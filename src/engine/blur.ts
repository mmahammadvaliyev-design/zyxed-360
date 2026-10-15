// Функция «Блюр»: зона панорамы, которую нужно размыть (лица, номера, секретное
// оборудование, штатив в надире). Зона — многоугольник из точек в углах обзора
// (yaw/pitch), как линии и заметки, поэтому не зависит от разрешения картинки.
//
// Размытие НЕОБРАТИМО попадает в то, что уходит клиенту: при экспорте (и в
// «просмотровый» index.html в папке тура) картинка панорамы перерисовывается
// уже размытой (bakeBlurs). Оригинал остаётся только в редакторе и в копии
// проекта — иначе клиент мог бы достать неразмытый снимок из файла тура.
import { clamp, dirFromAngles, project, unproject, wrapAngle, type Basis, type Vec3 } from "./pano";
import { bitmapSize, closeBitmap, loadBitmap, type Bitmap } from "./bitmap";
import type { BlurZone, LinePoint } from "./types";

export const MIN_BLUR_LEVEL = 1;
export const MAX_BLUR_LEVEL = 100;
export const DEFAULT_BLUR_LEVEL = 50;

// ── Геометрия зоны ────────────────────────────────────────────────

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Ребра многоугольника идут по большому кругу (а не по прямой в углах): так зона
// остаётся тем, что нарисовали на экране, и рядом с полюсами, и на широких кадрах.
export function densifyZone(points: LinePoint[], stepRad: number): LinePoint[] {
  const out: LinePoint[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const da = dirFromAngles(a.yaw, a.pitch);
    const db = dirFromAngles(b.yaw, b.pitch);
    const omega = Math.acos(clamp(dot3(da, db), -1, 1));
    const k = Math.max(1, Math.ceil(omega / stepRad));
    for (let j = 0; j < k; j++) {
      if (omega < 1e-6) {
        out.push(a);
        continue;
      }
      const t = j / k;
      const s = Math.sin(omega);
      const w1 = Math.sin((1 - t) * omega) / s;
      const w2 = Math.sin(t * omega) / s;
      const d: Vec3 = [da[0] * w1 + db[0] * w2, da[1] * w1 + db[1] * w2, da[2] * w1 + db[2] * w2];
      out.push({ yaw: Math.atan2(d[0], d[2]), pitch: Math.asin(clamp(d[1], -1, 1)) });
    }
  }
  return out;
}

// Зона по фигуре, нарисованной НА ЭКРАНЕ (прямоугольник / овал): берём много точек
// по контуру и переводим в углы — перспектива учтена сама.
export function zoneFromScreenShape(
  kind: "rect" | "ellipse",
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  basis: Basis,
  width: number,
  height: number,
): LinePoint[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const pts: { x: number; y: number }[] = [];
  if (kind === "ellipse") {
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const rx = (right - left) / 2;
    const ry = (bottom - top) / 2;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
  } else {
    const N = 10;
    for (let i = 0; i < N; i++) pts.push({ x: left + ((right - left) * i) / N, y: top });
    for (let i = 0; i < N; i++) pts.push({ x: right, y: top + ((bottom - top) * i) / N });
    for (let i = 0; i < N; i++) pts.push({ x: right - ((right - left) * i) / N, y: bottom });
    for (let i = 0; i < N; i++) pts.push({ x: left, y: bottom - ((bottom - top) * i) / N });
  }
  return pts.map((p) => unproject(p.x, p.y, basis, width, height));
}

// Экранные точки зоны (для контура и попадания). null — точка позади камеры.
function screenPoints(zone: LinePoint[], basis: Basis, width: number, height: number): ({ x: number; y: number } | null)[] {
  return densifyZone(zone, (2 * Math.PI) / 180).map((p) => project(p.yaw, p.pitch, basis, width, height));
}

function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Зона под точкой экрана (последняя нарисованная — «сверху»).
export function hitTestBlur(zones: BlurZone[], basis: Basis, width: number, height: number, x: number, y: number): string | null {
  for (let i = zones.length - 1; i >= 0; i--) {
    const pts = screenPoints(zones[i].points, basis, width, height).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length >= 3 && pointInPolygon(x, y, pts)) return zones[i].id;
  }
  return null;
}

// ── Рисование поверх панорамы (редактор) ──────────────────────────

export type BlurDraft =
  | { kind: "rect" | "ellipse"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "points"; points: LinePoint[] };

function tracePoly(ctx: CanvasRenderingContext2D, pts: ({ x: number; y: number } | null)[], close: boolean) {
  ctx.beginPath();
  let pen = false;
  let any = false;
  for (const p of pts) {
    if (!p) {
      pen = false;
      continue;
    }
    if (!pen) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
    pen = true;
    any = true;
  }
  if (close && any && pts.every((p) => p)) ctx.closePath();
}

// Контуры зон (только в редакторе): пунктир + лёгкая подсветка, выбранная — ярче.
// Сам эффект размытия виден по самой картинке (её перерисовывает редактор).
export function drawBlurZones(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  basis: Basis,
  zones: BlurZone[],
  selectedId: string | null,
  draft: BlurDraft | null,
): void {
  ctx.save();
  ctx.lineJoin = "round";
  for (const z of zones) {
    const sel = z.id === selectedId;
    const pts = screenPoints(z.points, basis, width, height);
    tracePoly(ctx, pts, true);
    ctx.setLineDash(sel ? [] : [7, 5]);
    ctx.lineWidth = sel ? 3.5 : 2;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.stroke();
    ctx.lineWidth = sel ? 2 : 1.4;
    ctx.strokeStyle = sel ? "#7fd0ff" : "#ffffff";
    ctx.stroke();
    if (sel) {
      ctx.fillStyle = "rgba(127,208,255,0.12)";
      ctx.fill();
    }
  }
  if (draft) {
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffd34e";
    ctx.fillStyle = "rgba(255,211,78,0.14)";
    if (draft.kind === "points") {
      const pts = draft.points.map((p) => project(p.yaw, p.pitch, basis, width, height));
      tracePoly(ctx, pts, false);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of pts) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#ffd34e";
        ctx.fill();
      }
    } else {
      const l = Math.min(draft.x0, draft.x1);
      const t = Math.min(draft.y0, draft.y1);
      const w = Math.abs(draft.x1 - draft.x0);
      const h = Math.abs(draft.y1 - draft.y0);
      ctx.beginPath();
      if (draft.kind === "ellipse") ctx.ellipse(l + w / 2, t + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(l, t, w, h);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Само размытие ─────────────────────────────────────────────────

// Радиус размытия в пикселях: пропорционален ширине картинки (чтобы вид не менялся
// от разрешения), растёт плавнее у малых значений ползунка.
export function blurRadiusPx(level: number, imageWidth: number): number {
  const k = clamp(level, MIN_BLUR_LEVEL, MAX_BLUR_LEVEL) / MAX_BLUR_LEVEL;
  return Math.max(1, Math.round(Math.pow(k, 1.5) * imageWidth * 0.03));
}

// Один проход «скользящего среднего» по выбранным каналам (края — как продолжение
// крайнего пикселя). horizontal=false — те же вычисления по столбцам.
function boxPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number, horizontal: boolean, channels: number[]) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;
  const div = 2 * r + 1;
  for (const c of channels) {
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep + c;
      let sum = src[base] * (r + 1);
      for (let i = 1; i <= r; i++) sum += src[base + Math.min(i, len - 1) * step];
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = (sum + (div >> 1)) / div;
        const add = Math.min(i + r + 1, len - 1);
        const sub = Math.max(i - r, 0);
        sum += src[base + add * step] - src[base + sub * step];
      }
    }
  }
}

// Три прохода по каждой оси ≈ гауссово размытие. Работает «на месте».
function blurData(data: Uint8ClampedArray, w: number, h: number, r: number, channels: number[]) {
  if (r < 1) return;
  const tmp = new Uint8ClampedArray(data.length);
  for (let i = 0; i < 3; i++) {
    boxPass(data, tmp, w, h, r, true, channels);
    boxPass(tmp, data, w, h, r, false, channels);
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Многоугольник зоны в пикселях равнопромежуточной картинки. Развёртка по yaw
// непрерывна (без скачка на шве ±180°); если зона накрывает полюс (штатив в надире),
// контур замыкается по краю картинки.
function zonePixelPolygon(points: LinePoint[], W: number, H: number): { x: number; y: number }[] {
  const dense = densifyZone(points, (0.4 * Math.PI) / 180);
  if (dense.length < 3) return [];
  const yaws: number[] = [dense[0].yaw];
  for (let i = 1; i < dense.length; i++) yaws.push(yaws[i - 1] + wrapAngle(dense[i].yaw - dense[i - 1].yaw));
  const closing = wrapAngle(dense[0].yaw - dense[dense.length - 1].yaw);
  const winding = Math.round((yaws[yaws.length - 1] + closing - yaws[0]) / (2 * Math.PI));
  const toPx = (yaw: number, pitch: number) => ({ x: (0.5 + yaw / (2 * Math.PI)) * W, y: (0.5 - pitch / Math.PI) * H });
  const poly = dense.map((p, i) => toPx(yaws[i], p.pitch));
  if (winding !== 0) {
    const meanPitch = dense.reduce((s, p) => s + p.pitch, 0) / dense.length;
    const pole = meanPitch >= 0 ? Math.PI / 2 : -Math.PI / 2;
    const yEnd = yaws[0] + 2 * Math.PI * winding;
    poly.push(toPx(yaws[yaws.length - 1], pole), toPx(yEnd, pole), toPx(yaws[0], pole));
  }
  return poly;
}

// Размытие куска картинки. Сильное размытие сглаживает всё сильнее, чем шаг
// пикселя, поэтому при большом радиусе считаем на уменьшенной копии и растягиваем
// обратно: результат на вид тот же, а считается в разы быстрее.
function blurRegion(orig: ImageData, r: number): ImageData {
  const w = orig.width;
  const h = orig.height;
  const f = clamp(Math.floor(r / 8), 1, 8);
  if (f === 1) {
    const out = new ImageData(new Uint8ClampedArray(orig.data), w, h);
    blurData(out.data, w, h, r, [0, 1, 2]);
    return out;
  }
  const full = makeCanvas(w, h);
  const fctx = full.getContext("2d", { willReadFrequently: true })!;
  fctx.putImageData(orig, 0, 0);
  const sw = Math.max(2, Math.ceil(w / f));
  const sh = Math.max(2, Math.ceil(h / f));
  const small = makeCanvas(sw, sh);
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(full, 0, 0, sw, sh);
  const sd = sctx.getImageData(0, 0, sw, sh);
  blurData(sd.data, sw, sh, Math.max(1, Math.round(r / f)), [0, 1, 2]);
  sctx.putImageData(sd, 0, 0);
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = "high";
  fctx.drawImage(small, 0, 0, w, h);
  return fctx.getImageData(0, 0, w, h);
}

function blurZoneInto(ctx: CanvasRenderingContext2D, W: number, H: number, zone: BlurZone) {
  const poly = zonePixelPolygon(zone.points, W, H);
  if (!poly.length) return;
  const r = blurRadiusPx(zone.level, W);
  const feather = Math.max(1, Math.round(r * 0.35)); // мягкий край: внутри зоны размыто полностью, снаружи плавно сходит на нет
  const pad = Math.ceil(r * 2 + feather * 2 + 2);
  for (const shift of [-W, 0, W]) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      const x = p.x + shift;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const x0 = Math.max(0, Math.floor(minX - pad));
    const y0 = Math.max(0, Math.floor(minY - pad));
    const x1 = Math.min(W, Math.ceil(maxX + pad));
    const y1 = Math.min(H, Math.ceil(maxY + pad));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) continue;

    const orig = ctx.getImageData(x0, y0, w, h);
    const blurred = blurRegion(orig, r);

    // маска зоны: заливка + обводка шириной 2*feather (внутренний запас), затем
    // размытие альфа-канала — получается плавный переход
    const mc = makeCanvas(w, h);
    const mctx = mc.getContext("2d")!;
    mctx.beginPath();
    poly.forEach((p, i) => (i ? mctx.lineTo(p.x + shift - x0, p.y - y0) : mctx.moveTo(p.x + shift - x0, p.y - y0)));
    mctx.closePath();
    mctx.fillStyle = "#fff";
    mctx.fill();
    mctx.lineWidth = feather * 2;
    mctx.lineJoin = "round";
    mctx.strokeStyle = "#fff";
    mctx.stroke();
    const mask = mctx.getImageData(0, 0, w, h);
    blurData(mask.data, w, h, feather, [3]);

    const o = orig.data;
    const b = blurred.data;
    const m = mask.data;
    for (let i = 0; i < o.length; i += 4) {
      const a = m[i + 3] / 255;
      if (a <= 0) continue;
      o[i] = o[i] + (b[i] - o[i]) * a;
      o[i + 1] = o[i + 1] + (b[i + 1] - o[i + 1]) * a;
      o[i + 2] = o[i + 2] + (b[i + 2] - o[i + 2]) * a;
    }
    ctx.putImageData(orig, x0, y0);
  }
}

// Картинка панорамы с применёнными зонами → канвас. maxWidth — для быстрого
// предпросмотра в редакторе (картинка уменьшается, радиус масштабируется сам).
async function bakeCanvas(image: Blob, zones: BlurZone[], maxWidth?: number): Promise<HTMLCanvasElement> {
  const bmp = await loadBitmap(image);
  const size = bitmapSize(bmp);
  const scale = maxWidth && size.width > maxWidth ? maxWidth / size.width : 1;
  const W = Math.max(2, Math.round(size.width * scale));
  const H = Math.max(2, Math.round(size.height * scale));
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    closeBitmap(bmp);
    throw new Error("Не удалось подготовить размытие: нет 2D-канваса.");
  }
  ctx.drawImage(bmp as CanvasImageSource, 0, 0, W, H);
  closeBitmap(bmp);
  for (const z of zones) if (z.points.length >= 3) blurZoneInto(ctx, W, H, z);
  return canvas;
}

// Для экспорта/папки: размытая картинка как JPEG.
export async function bakeBlurs(image: Blob, zones: BlurZone[], opts: { maxWidth?: number; quality?: number } = {}): Promise<Blob> {
  const canvas = await bakeCanvas(image, zones, opts.maxWidth);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось сохранить размытую картинку."))), "image/jpeg", opts.quality ?? 0.92);
  });
}

// Для просмотра в редакторе: сразу битмап для WebGL-текстуры (без кодирования в JPEG).
export async function bakeBlursToBitmap(image: Blob, zones: BlurZone[], maxWidth?: number): Promise<Bitmap> {
  const canvas = await bakeCanvas(image, zones, maxWidth);
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(canvas);
    } catch {
      /* падаем на JPEG ниже */
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.92));
  return loadBitmap(blob);
}
