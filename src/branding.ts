// Брендинг опубликованного тура: свой логотип + подпись в углу плеера.
// Настройка одна на всё приложение (не на конкретный тур — обычно это лого
// своей компании), хранится в localStorage как data: URI. Встраивается в
// экспорт только если функция «Брендинг тура» включена (см. features.ts).
import { useSyncExternalStore } from "react";

export interface Branding {
  logo?: string; // data: URI, до ~240px — маленькая картинка
  text?: string;
}

const STORAGE_KEY = "zyxed360:branding";

function load(): Branding {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let state = load();
let listeners: Array<() => void> = [];

function emit(): void {
  for (const l of listeners) l();
}

export function getBranding(): Branding {
  return state;
}

export function setBranding(patch: Partial<Branding>): void {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* приватный режим/квота — просто не запомнится между сессиями */
  }
  emit();
}

export function useBranding(): Branding {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => state,
  );
}
