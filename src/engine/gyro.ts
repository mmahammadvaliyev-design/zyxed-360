// Управление обзором с гироскопа: событие deviceorientation → углы взгляда.
// Кватернионы нужны, чтобы наклон телефона не «залипал» у зенита (гимбал-лок).
// Без React — используется и в приложении, и в автономном плеере.
import { clamp, type Vec3 } from "./pano";

type Quat = [number, number, number, number]; // x, y, z, w

function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

// Порядок YXZ — тот же, в котором браузер отдаёт alpha/beta/gamma.
function qFromEulerYXZ(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

function qFromAxisZ(angle: number): Quat {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

function qRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  const ccx = y * cz - z * cy;
  const ccy = z * cx - x * cz;
  const ccz = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + ccx), v[1] + 2 * (w * cy + ccy), v[2] + 2 * (w * cz + ccz)];
}

// Экран повёрнут (альбомная ориентация) — обзор надо повернуть на тот же угол.
export function screenAngle(): number {
  const a = window.screen?.orientation?.angle;
  if (typeof a === "number") return (a * Math.PI) / 180;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? (legacy * Math.PI) / 180 : 0;
}

// Наклон телефона → куда смотрит камера. null, если датчик ещё не дал данных.
export function anglesFromOrientation(e: DeviceOrientationEvent): { yaw: number; pitch: number } | null {
  if (e.alpha == null || e.beta == null || e.gamma == null) return null;
  const toRad = Math.PI / 180;
  const device = qFromEulerYXZ(e.beta * toRad, e.alpha * toRad, -e.gamma * toRad);
  // Телефон держат экраном к себе: разворачиваем систему координат на -90° вокруг X.
  const upright: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const q = qMul(qMul(device, upright), qFromAxisZ(-screenAngle()));
  const fwd = qRotate(q, [0, 0, -1]);
  return { yaw: Math.atan2(fwd[0], fwd[2]), pitch: Math.asin(clamp(fwd[1], -1, 1)) };
}

// На iOS доступ к датчику нужно спросить явно, и только по нажатию кнопки.
export async function requestGyroPermission(): Promise<boolean> {
  const anyDOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof anyDOE?.requestPermission !== "function") return true;
  try {
    return (await anyDOE.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export const GYRO_SUPPORTED = typeof window !== "undefined" && "DeviceOrientationEvent" in window;
