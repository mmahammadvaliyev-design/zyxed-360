// Брендинг опубликованного тура: логотип + подпись в углу плеера. Всегда
// включён (отдельного тумблера нет); по умолчанию — логотип ZYXED Engineering,
// его можно заменить своим в настройках. Настройка одна на всё приложение
// (не на конкретный тур), хранится в localStorage как data: URI.
import { useSyncExternalStore } from "react";
import { DEFAULT_LOGO } from "./brandingDefault";

export interface Branding {
  logo?: string; // data: URI, до ~240px — маленькая картинка
  text?: string;
}

const STORAGE_KEY = "zyxed360:branding";

// В state всегда лежит «эффективное» значение (с логотипом по умолчанию), а в
// localStorage — только то, что задал пользователь.
function withDefault(raw: Branding): Branding {
  return { ...raw, logo: raw.logo ?? DEFAULT_LOGO };
}

function load(): Branding {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return withDefault(raw ? JSON.parse(raw) : {});
  } catch {
    return withDefault({});
  }
}

export function isDefaultLogo(logo: string | undefined): boolean {
  return !logo || logo === DEFAULT_LOGO;
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
  state = withDefault({ ...state, ...patch });
  try {
    const custom: Branding = { text: state.text };
    if (!isDefaultLogo(state.logo)) custom.logo = state.logo;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
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
