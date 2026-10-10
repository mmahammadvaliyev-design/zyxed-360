// Функция «Линии» (хайлайтер): линия трубопровода/кабеля/маршрута, которую
// отмечают поверх панорамы цветным «маркером». Линия — объект ВСЕГО тура
// (название + цвет, LineDef), а на каждой панораме у неё свои штрихи (Stroke):
// ломаная из точек в углах обзора (yaw/pitch), как и у переходов/заметок.
// Модуль общий для приложения и автономного плеера: геометрия и отрисовка на
// 2D-канвасе поверх WebGL-панорамы.
import { clamp, dirFromAngles, rad, wrapAngle, type Basis, type Vec3 } from "./pano";
import type { LineDef, LinePoint, Stroke } from "./types";

// Палитра по умолчанию — насыщенные цвета, читаемые поверх любых панорам.
export const LINE_COLORS = ["#ff3b30", "#ffd60a", "#34c759", "#0a84ff", "#bf5af2", "#ff9f0a", "#00c7be", "#ff2d92"];

// У линии есть что показать по клику (текст/фото/файлы/ссылки).
export function lineHasDocs(l: LineDef): boolean {
  return !!(l.note?.trim() || l.photo || l.photoUrl || l.pdfs?.length);
}

export function nextLineColor(lines: LineDef[]): string {
  const used = new Set(lines.map((l) => l.color.toLowerCase()));
  return LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[lines.length % LINE_COLORS.length];
}

const SEGMENT_STEP = rad(1.5); // шаг дробления отрезка по дуге большого круга
// Толщина линии задаётся в угловой мере (градусы обзора) — тогда она
// «прилипает» к трубе при зуме. Это и ширина маркера, и ширина кликабельной
// зоны: широкая линия накрывает трубу большого диаметра целиком.
export const DEFAULT_LINE_WIDTH_DEG = 2.5;
export const MIN_LINE_WIDTH_DEG = 0.4;
export const MAX_LINE_WIDTH_DEG = 14;
const MIN_WIDTH_PX = 4;
const MAX_WIDTH_PX = 320;
const TOUCH_SLOP_PX = 10; // запас на неточность пальца вокруг зоны

// Толщина линии: сначала значение для данной панорамы (overrides —
// Scene.lineWidths), затем общая толщина линии, затем 2.5°.
export function lineWidthDeg(l: Pick<LineDef, "id" | "width">, overrides?: Record<string, number>): number {
  return clamp(overrides?.[l.id] ?? l.width ?? DEFAULT_LINE_WIDTH_DEG, MIN_LINE_WIDTH_DEG, MAX_LINE_WIDTH_DEG);
}
function widthPx(widthDeg: number, scale: number): number {
  return clamp(rad(widthDeg) * scale, MIN_WIDTH_PX, MAX_WIDTH_PX);
}

// Сужение к концу: во сколько раз конец штриха тоньше начала.
export const TAPER_END = 0.3;
// Ширина в i-й из n точек штриха (в пикселях).
function widthAt(i: number, n: number, w: number, taper: boolean): number {
  if (!taper || n < 2) return w;
  return Math.max(MIN_WIDTH_PX, w * (1 - (1 - TAPER_END) * (i / (n - 1))));
}

// Лента переменной ширины: один заливочный проход (поэтому полупрозрачность
// не «перекрашивается» в местах стыков), с круглыми концами.
function fillRibbon(ctx: CanvasRenderingContext2D, pts: ({ x: number; y: number } | null)[], widths: number[], color: string, alpha: number) {
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  let run: { x: number; y: number; w: number }[] = [];
  const flush = () => {
    if (run.length) drawRun(run);
    run = [];
  };
  const drawRun = (r: { x: number; y: number; w: number }[]) => {
    ctx.beginPath();
    if (r.length >= 2) {
      const left: { x: number; y: number }[] = [];
      const right: { x: number; y: number }[] = [];
      for (let i = 0; i < r.length; i++) {
        const a = r[Math.max(0, i - 1)];
        const b = r[Math.min(r.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        left.push({ x: r[i].x + (nx * r[i].w) / 2, y: r[i].y + (ny * r[i].w) / 2 });
        right.push({ x: r[i].x - (nx * r[i].w) / 2, y: r[i].y - (ny * r[i].w) / 2 });
      }
      const poly = [...left, ...right.reverse()];
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        area += p.x * q.y - q.x * p.y;
      }
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      // Круглые концы — в том же пути и с той же ориентацией, чтобы заливка
      // nonzero не вырезала дырки на стыках.
      for (const e of [r[0], r[r.length - 1]]) {
        ctx.moveTo(e.x + e.w / 2, e.y);
        ctx.arc(e.x, e.y, e.w / 2, 0, Math.PI * 2, area < 0);
      }
    } else {
      ctx.arc(r[0].x, r[0].y, r[0].w / 2, 0, Math.PI * 2);
    }
    ctx.fill("nonzero");
  };
  pts.forEach((p, i) => {
    if (!p) flush();
    else run.push({ x: p.x, y: p.y, w: widths[i] });
  });
  flush();
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function projectDir(d: Vec3, b: Basis, width: number, height: number): { x: number; y: number } | null {
  const z = dot(d, b.f);
  if (z <= 0.0001) return null;
  const nx = dot(d, b.r) / z / (b.tanHalf * b.aspect);
  const ny = dot(d, b.u) / z / b.tanHalf;
  if (Math.abs(nx) > 3 || Math.abs(ny) > 3) return null;
  return { x: (nx * 0.5 + 0.5) * width, y: (0.5 - ny * 0.5) * height };
}

// Точки ломаной → экранные точки. Отрезки между вершинами идут по дуге
// большого круга (в проекции перспективной камеры это прямая линия), поэтому
// дробим и проецируем каждую часть; null — разрыв (часть за камерой/далеко
// за краем кадра).
function samplePath(points: LinePoint[], b: Basis, width: number, height: number): ({ x: number; y: number } | null)[] {
  const out: ({ x: number; y: number } | null)[] = [];
  if (!points.length) return out;
  const dirs = points.map((p) => dirFromAngles(p.yaw, p.pitch));
  out.push(projectDir(dirs[0], b, width, height));
  for (let i = 0; i < dirs.length - 1; i++) {
    const a = dirs[i];
    const c = dirs[i + 1];
    const angle = Math.acos(clamp(dot(a, c), -1, 1));
    const steps = Math.max(1, Math.ceil(angle / SEGMENT_STEP));
    const sinA = Math.sin(angle);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      let v: Vec3;
      if (sinA < 1e-6) v = c;
      else {
        const k1 = Math.sin((1 - t) * angle) / sinA;
        const k2 = Math.sin(t * angle) / sinA;
        v = [a[0] * k1 + c[0] * k2, a[1] * k1 + c[1] * k2, a[2] * k1 + c[2] * k2];
      }
      out.push(projectDir(v, b, width, height));
    }
  }
  return out;
}

function tracePath(ctx: CanvasRenderingContext2D, pts: ({ x: number; y: number } | null)[]) {
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (!p) {
      pen = false;
      continue;
    }
    if (!pen) {
      ctx.moveTo(p.x, p.y);
      // одиночная точка с круглым колпачком должна быть видна
      ctx.lineTo(p.x + 0.01, p.y);
      pen = true;
    } else ctx.lineTo(p.x, p.y);
  }
}

export interface DraftStroke {
  points: LinePoint[];
  color: string;
  vertices: boolean; // показывать вершины (режим «по точкам»)
  smooth?: boolean;
  widthDeg?: number;
  taper?: boolean;
}

// Плавная кривая ЧЕРЕЗ заданные точки (центрипетальный Catmull–Rom: проходит
// ровно через вершины, которые поставил пользователь, и не «раздувается» на
// резких поворотах). Считаем в плоскости (yaw·cos(pitch), pitch) — на масштабе
// одной трубы это точно, а yaw разворачиваем, чтобы не ломаться на ±π.
export function smoothCurve(points: LinePoint[]): LinePoint[] {
  if (points.length < 3) return points;
  const meanPitch = points.reduce((a, p) => a + p.pitch, 0) / points.length;
  const c = Math.max(0.05, Math.cos(meanPitch));
  const yaw0 = points[0].yaw;
  const xs: number[] = [0];
  for (let i = 1; i < points.length; i++) xs.push(xs[i - 1] + wrapAngle(points[i].yaw - points[i - 1].yaw));
  const P = points.map((p, i) => ({ x: xs[i] * c, y: p.pitch }));
  const ext = [{ x: 2 * P[0].x - P[1].x, y: 2 * P[0].y - P[1].y }, ...P, { x: 2 * P[P.length - 1].x - P[P.length - 2].x, y: 2 * P[P.length - 1].y - P[P.length - 2].y }];
  const out: LinePoint[] = [points[0]];
  const dt = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-4);
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, k: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const t0 = 0, t1 = t0 + dt(p0, p1), t2 = t1 + dt(p1, p2), t3 = t2 + dt(p2, p3);
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.min(24, Math.max(4, Math.ceil(segLen / rad(1))));
    for (let s = 1; s <= n; s++) {
      const t = t1 + ((t2 - t1) * s) / n;
      const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
      const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
      const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
      const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
      const q = lerp(b1, b2, (t - t1) / (t2 - t1));
      out.push({ yaw: wrapAngle(yaw0 + q.x / c), pitch: clamp(q.y, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01) });
    }
  }
  return out;
}

// Рисует штрихи текущей панорамы. focusId — подсвеченная линия: остальные
// приглушаются. Канвас очищает вызывающий.
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  basis: Basis,
  strokes: Stroke[],
  lines: LineDef[],
  focusId: string | null,
  draft?: DraftStroke | null,
  ghostHidden = false, // в режиме правки «невидимые» линии рисуем бледно, чтобы автор видел зоны
  widths?: Record<string, number>, // толщина линий на этой панораме (Scene.lineWidths)
): void {
  const scale = height / (2 * basis.tanHalf);
  const focus = focusId && strokes.some((s) => s.lineId === focusId) ? focusId : null;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const paint = (pts: ({ x: number; y: number } | null)[], color: string, strength: number, w: number, taper = false) => {
    if (taper) {
      const n = pts.length;
      const glow = pts.map((_, i) => widthAt(i, n, w, true) + clamp(widthAt(i, n, w, true) * 0.45, 6, 22));
      fillRibbon(ctx, pts, glow, color, 0.16 * strength); // мягкое свечение
      fillRibbon(ctx, pts, pts.map((_, i) => widthAt(i, n, w, true)), color, 0.62 * strength);
      return;
    }
    tracePath(ctx, pts);
    ctx.strokeStyle = color;
    ctx.lineWidth = w + clamp(w * 0.45, 6, 22); // мягкое свечение
    ctx.globalAlpha = 0.16 * strength;
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.globalAlpha = 0.62 * strength;
    ctx.stroke();
  };

  for (const s of strokes) {
    const def = lines.find((l) => l.id === s.lineId);
    if (!def || s.points.length < 2) continue;
    // Невидимая линия появляется только когда её выбрали в легенде.
    const hiddenNow = !!def.hidden && focus !== def.id;
    if (hiddenNow && !ghostHidden) continue;
    const pts = samplePath(s.smooth ? smoothCurve(s.points) : s.points, basis, width, height);
    if (hiddenNow) {
      // Невидимая линия в режиме правки: тонкий пунктир по оси — сразу видно, что
      // она «выключена» (мазок с прозрачностью у ярких цветов выглядел как включённый).
      ctx.save();
      ctx.setLineDash([7, 6]);
      tracePath(ctx, pts);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = def.color;
      ctx.stroke();
      ctx.restore();
      continue;
    }
    const strength = focus && focus !== s.lineId ? 0.22 : 1;
    paint(pts, def.color, strength, widthPx(lineWidthDeg(def, widths), scale), !!def.taper);
  }

  if (draft && draft.points.length) {
    const pts = samplePath(draft.smooth ? smoothCurve(draft.points) : draft.points, basis, width, height);
    if (draft.points.length > 1) paint(pts, draft.color, 1, widthPx(draft.widthDeg ?? DEFAULT_LINE_WIDTH_DEG, scale), !!draft.taper);
    if (draft.vertices) {
      ctx.globalAlpha = 1;
      for (const p of draft.points) {
        const sp = projectDir(dirFromAngles(p.yaw, p.pitch), basis, width, height);
        if (!sp) continue;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = draft.color;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

// Угловое расстояние между точками (радианы).
export function angularDistance(a: LinePoint, b: LinePoint): number {
  return Math.acos(clamp(dot(dirFromAngles(a.yaw, a.pitch), dirFromAngles(b.yaw, b.pitch)), -1, 1));
}

// Штрих «от руки» дрожит: 2 прохода скользящего среднего (концы не трогаем),
// затем упрощение Дугласа–Пекера — в хранилище остаётся несколько десятков
// точек вместо сотен, а линия — гладкая.
export function smoothAndSimplify(points: LinePoint[], tolDeg = 0.18): LinePoint[] {
  if (points.length < 3) return points.slice();
  let pts = points.map((p) => ({ ...p }));
  const y0 = pts[0].yaw;
  // yaw разворачиваем относительно первой точки, чтобы не ломаться на ±π
  pts = pts.map((p) => ({ yaw: wrapAngle(p.yaw - y0), pitch: p.pitch }));
  for (let pass = 0; pass < 2; pass++) {
    const next = pts.map((p) => ({ ...p }));
    for (let i = 1; i < pts.length - 1; i++) {
      next[i] = { yaw: (pts[i - 1].yaw + pts[i].yaw + pts[i + 1].yaw) / 3, pitch: (pts[i - 1].pitch + pts[i].pitch + pts[i + 1].pitch) / 3 };
    }
    pts = next;
  }
  const tol = rad(tolDeg);
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const planar = (p: LinePoint) => ({ x: p.yaw * Math.cos(p.pitch), y: p.pitch });
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = planar(pts[a]);
    const pb = planar(pts[b]);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const p = planar(pts[i]);
      const d = Math.abs((p.x - pa.x) * dy - (p.y - pa.y) * dx) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map((p) => ({ yaw: wrapAngle(p.yaw + y0), pitch: p.pitch }));
}

// Клик/тап по зоне линии: ближайшая линия к точке (x, y) в пикселях кадра,
// если она ближе допуска (≥ толщины маркера и минимум 18 px — пальцу нужен
// запас). Работает и для «невидимых» линий.
export function hitTestStrokes(
  strokes: Stroke[],
  lines: LineDef[],
  basis: Basis,
  width: number,
  height: number,
  x: number,
  y: number,
  widths?: Record<string, number>,
): string | null {
  const scale = height / (2 * basis.tanHalf);
  let best: { id: string; d: number } | null = null;
  for (const s of strokes) {
    const def = lines.find((l) => l.id === s.lineId);
    if (!def || s.points.length < 2) continue;
    // Зона = вся полоса линии (половина ширины в каждую сторону, с учётом
    // сужения к концу) + запас под палец.
    const w0 = widthPx(lineWidthDeg(def, widths), scale);
    const pts = samplePath(s.smooth ? smoothCurve(s.points) : s.points, basis, width, height);
    for (let i = 0; i < pts.length - 1; i++) {
      const tol = widthAt(i, pts.length, w0, !!def.taper) / 2 + TOUCH_SLOP_PX;
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 < 1e-9 ? 0 : clamp(((x - a.x) * dx + (y - a.y) * dy) / l2, 0, 1);
      const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
      if (d <= tol && (!best || d < best.d)) best = { id: s.lineId, d };
    }
  }
  return best ? best.id : null;
}
