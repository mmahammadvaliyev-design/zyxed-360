// Переключаемые дополнительные функции приложения. Каждая фича — свой пункт
// в «Настройках», включается/выключается независимо и хранится в localStorage
// (это настройка устройства, не данные тура — незачем класть в Dexie).
// Текущее состояние снимком уходит и в TourManifest при экспорте (см.
// export/bundle.ts), чтобы опубликованный плеер вёл себя так же, как было
// на момент экспорта.
import { useSyncExternalStore } from "react";

export interface FeatureFlag {
  id: string;
  label: string;
  description: string;
  defaultOn: boolean;
}

export const FEATURES: FeatureFlag[] = [
  {
    id: "richNotes",
    label: "Богатые заметки",
    description:
      "Инфо-точки (без перехода на другую панораму) открывают карточку с описанием и фото вместо короткой всплывающей подписи на пару секунд.",
    defaultOn: false,
  },
  {
    id: "linearChain",
    label: "Линейная цепочка переходов",
    description:
      "Кнопка «Связать по порядку» в редакторе — как «Связать по кругу», но без замыкания: для маршрута без цикла (труба, коридор, последовательность объектов).",
    defaultOn: false,
  },
];

const STORAGE_KEY = "zyxed360:features";

function loadStored(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let stored = loadStored();
let listeners: Array<() => void> = [];

function emit(): void {
  for (const l of listeners) l();
}

export function isFeatureEnabled(id: string): boolean {
  if (id in stored) return stored[id];
  return FEATURES.find((f) => f.id === id)?.defaultOn ?? false;
}

export function setFeatureEnabled(id: string, on: boolean): void {
  stored = { ...stored, [id]: on };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* приватный режим/квота — фича просто не запомнится между сессиями */
  }
  emit();
}

export function useFeature(id: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => isFeatureEnabled(id),
  );
}

// Снимок всех фич разом — кладём в экспортируемый манифест тура.
export function getFeatureSnapshot(): Record<string, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f.id, isFeatureEnabled(f.id)]));
}
