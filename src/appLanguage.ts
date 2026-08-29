// Язык приложения — общая настройка (не свойство конкретного тура), решает,
// какой вариант текста (RU/EN) показывать везде, где для панорамы/перехода
// задан английский вариант (функция «RU/EN тур», см. features.ts), и на каком
// языке будет собран экспорт: в отличие от прежнего переключателя внутри
// самого тура, опубликованный плеер языка не выбирает — он получает готовый,
// уже выбранный на момент экспорта язык в манифесте (см. export/bundle.ts).
import { useSyncExternalStore } from "react";

export type AppLang = "ru" | "en";

const STORAGE_KEY = "zyxed360:appLang";

function load(): AppLang {
  try {
    return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ru";
  } catch {
    return "ru";
  }
}

let lang: AppLang = load();
let listeners: Array<() => void> = [];

function emit(): void {
  for (const l of listeners) l();
}

export function getAppLanguage(): AppLang {
  return lang;
}

export function setAppLanguage(next: AppLang): void {
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* приватный режим/квота — просто не запомнится между сессиями */
  }
  emit();
}

export function useAppLanguage(): AppLang {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => lang,
  );
}
