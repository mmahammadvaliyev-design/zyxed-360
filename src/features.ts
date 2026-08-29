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
    id: "circleLink",
    label: "Связать по кругу",
    description:
      "Кнопка «Связать по кругу» в редакторе — быстро проставляет переходы по кругу между всеми панорамами. Включено по умолчанию, это исходное поведение приложения — выключите, если кнопка не нужна.",
    defaultOn: true,
  },
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
  {
    id: "slideshow",
    label: "Автотур (слайд-шоу)",
    description:
      "Кнопка ▶ в самом туре — панорамы сами пролистываются по кругу с паузой между ними, для презентаций и киосков без оператора. Работает и в приложении, и в опубликованном туре.",
    defaultOn: false,
  },
  {
    id: "branding",
    label: "Брендинг тура",
    description:
      "Свой логотип и подпись в углу опубликованного тура (и в предпросмотре) — настраивается в этих же настройках, одна пара логотип+подпись на все туры.",
    defaultOn: false,
  },
  {
    id: "qrCode",
    label: "QR-код тура",
    description:
      "Кнопка «QR-код» в редакторе — вставляете ссылку на уже опубликованный тур (после загрузки экспорта на хостинг), получаете QR-код для печати в отчёте или на объекте. Генерируется прямо в браузере, без сети.",
    defaultOn: false,
  },
  {
    id: "compression",
    label: "Сжатие панорам при импорте",
    description:
      "Выбор качества при добавлении панорам — «Стандарт»/«Компактно» ужимают разрешение и JPEG-качество, чтобы тур с большим числом панорам весил меньше. По умолчанию — без доп. сжатия, как раньше.",
    defaultOn: false,
  },
  {
    id: "dragReorder",
    label: "Перетаскивание панорам для сортировки",
    description:
      "Ручка ⠿ у каждой панорамы в списке — перетащите, чтобы переставить в любое место одним движением, вместо пошагового ↑/↓. Работает и мышью, и пальцем на телефоне.",
    defaultOn: false,
  },
  {
    id: "i18n",
    label: "RU/EN тур",
    description:
      "Для каждой панорамы и подписи перехода можно задать английский вариант в редакторе; если не задан, показывается русский. Язык показа — общая настройка приложения (выбирается ниже), в самом туре переключателя нет: экспорт всегда собирается на том языке, что выбран сейчас в приложении.",
    defaultOn: false,
  },
  {
    id: "projectBackup",
    label: "Резервная копия / перенос проекта",
    description:
      "Кнопки «Копия» (скачать весь редактируемый проект — панорамы, переходы, заметки) и «Импортировать копию» на главном экране — перенос тура на другое устройство или в другой браузер, а не только просмотр готового экспорта.",
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
