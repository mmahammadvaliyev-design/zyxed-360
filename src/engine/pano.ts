// 360°-панорамы: математика обзора и WebGL-рендер равнопромежуточной (equirectangular)
// картинки. Никаких внешних библиотек и React — этот файл используется и в приложении,
// и в автономном плеере, который уходит в экспортированный тур.

export interface View {
  yaw: number; // поворот вокруг вертикали, радианы
  pitch: number; // наклон вверх/вниз, радианы
  fov: number; // вертикальный угол обзора, радианы
}

export const MIN_FOV = (30 * Math.PI) / 180;
export const MAX_FOV = (100 * Math.PI) / 180;
export const DEFAULT_FOV = (75 * Math.PI) / 180;
export const MAX_PITCH = Math.PI / 2 - 0.02;

export const deg = (rad: number) => (rad * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Нормализация угла в (-π, π] — чтобы yaw не рос бесконечно.
export function wrapAngle(a: number): number {
  const t = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

export type Vec3 = [number, number, number];

// Направление взгляда по углам. Ось Y — вверх.
export function dirFromAngles(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export interface Basis {
  f: Vec3; // вперёд
  r: Vec3; // вправо
  u: Vec3; // вверх
  tanHalf: number;
  aspect: number;
}

// Базис камеры для текущего вида и пропорций экрана.
// Смотрим изнутри сферы, поэтому «вправо» — это cross(вверх, вперёд):
// при обратном порядке панорама показалась бы зеркально.
export function basisFor(view: View, width: number, height: number): Basis {
  const f = dirFromAngles(view.yaw, view.pitch);
  const r = norm(cross([0, 1, 0], f));
  const u = cross(f, r);
  return { f, r, u, tanHalf: Math.tan(view.fov / 2), aspect: width / Math.max(1, height) };
}

// Точка на сфере → координаты на экране (px). null, если позади камеры.
export function project(
  yaw: number,
  pitch: number,
  b: Basis,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const d = dirFromAngles(yaw, pitch);
  const z = dot(d, b.f);
  if (z <= 0.0001) return null;
  const nx = dot(d, b.r) / z / (b.tanHalf * b.aspect);
  const ny = dot(d, b.u) / z / b.tanHalf;
  if (Math.abs(nx) > 3 || Math.abs(ny) > 3) return null; // далеко за краем экрана
  return { x: (nx * 0.5 + 0.5) * width, y: (0.5 - ny * 0.5) * height };
}

// Точка экрана (px) → углы на сфере. Обратная к project.
export function unproject(
  x: number,
  y: number,
  b: Basis,
  width: number,
  height: number,
): { yaw: number; pitch: number } {
  const nx = (x / width) * 2 - 1;
  const ny = 1 - (y / height) * 2;
  const d = norm([
    b.f[0] + b.r[0] * nx * b.tanHalf * b.aspect + b.u[0] * ny * b.tanHalf,
    b.f[1] + b.r[1] * nx * b.tanHalf * b.aspect + b.u[1] * ny * b.tanHalf,
    b.f[2] + b.r[2] * nx * b.tanHalf * b.aspect + b.u[2] * ny * b.tanHalf,
  ]);
  return { yaw: Math.atan2(d[0], d[2]), pitch: Math.asin(clamp(d[1], -1, 1)) };
}

// ── WebGL-рендер ──────────────────────────────────────────────────
// Рисуем один полноэкранный треугольник: для каждого пикселя считаем луч
// и берём цвет из панорамы. Так не нужна геометрия сферы, и картинка точная.

const VERT = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_ndc;
uniform sampler2D u_tex;
uniform vec3 u_f;
uniform vec3 u_r;
uniform vec3 u_u;
uniform float u_tanHalf;
uniform float u_aspect;
const float PI = 3.141592653589793;
void main() {
  vec3 dir = normalize(u_f + u_r * (v_ndc.x * u_tanHalf * u_aspect) + u_u * (v_ndc.y * u_tanHalf));
  float s = 0.5 + atan(dir.x, dir.z) / (2.0 * PI);
  float t = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI;
  gl_FragColor = texture2D(u_tex, vec2(s, t));
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

const isPot = (n: number) => n > 0 && (n & (n - 1)) === 0;

export class PanoRenderer {
  readonly ok: boolean;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private buf: WebGLBuffer | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private hasImage = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = (canvas.getContext("webgl", { alpha: false, antialias: false, depth: false }) ||
      canvas.getContext("experimental-webgl", { alpha: false })) as WebGLRenderingContext | null;
    if (!gl) {
      this.ok = false;
      return;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !prog) {
      this.ok = false;
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.ok = false;
      return;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(prog);
    for (const name of ["u_tex", "u_f", "u_r", "u_u", "u_tanHalf", "u_aspect"]) {
      this.loc[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform1i(this.loc.u_tex, 0);

    this.gl = gl;
    this.program = prog;
    this.buf = buf;
    this.ok = true;
  }

  get maxTextureSize(): number {
    return this.gl ? (this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number) : 4096;
  }

  setImage(img: TexImageSource, width: number, height: number): void {
    const gl = this.gl;
    if (!gl) return;
    if (!this.tex) this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // Без переворота: для ImageBitmap флаг UNPACK_FLIP_Y браузеры игнорируют,
    // поэтому строку 0 текстуры всегда считаем верхом картинки (зенитом).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    // По горизонтали панорама замкнута: если размер — степень двойки, склейка
    // получается бесшовной. Иначе WebGL 1 разрешает только зажатие по краю.
    const wrapS = isPot(width) && isPot(height) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.hasImage = true;
  }

  // Подгоняем буфер кадра под реальный размер элемента. Возвращает размер в CSS-пикселях.
  resize(): { width: number; height: number } {
    const gl = this.gl;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      if (gl) gl.viewport(0, 0, pw, ph);
    }
    return { width, height };
  }

  render(basis: Basis): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.hasImage) return;
    gl.uniform3fv(this.loc.u_f, basis.f);
    gl.uniform3fv(this.loc.u_r, basis.r);
    gl.uniform3fv(this.loc.u_u, basis.u);
    gl.uniform1f(this.loc.u_tanHalf, basis.tanHalf);
    gl.uniform1f(this.loc.u_aspect, basis.aspect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.buf) gl.deleteBuffer(this.buf);
    if (this.program) gl.deleteProgram(this.program);
    this.gl = null;
    this.tex = null;
    this.buf = null;
    this.program = null;
    this.hasImage = false;
  }
}
