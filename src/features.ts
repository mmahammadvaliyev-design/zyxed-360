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
  labelEn: string;
  description: string;
  descriptionEn: string;
  defaultOn: boolean;
}

export const FEATURES: FeatureFlag[] = [
  {
    id: "circleLink",
    label: "Связать по кругу",
    labelEn: "Link in a circle",
    description:
      "Кнопка «Связать по кругу» в редакторе — быстро проставляет переходы по кругу между всеми панорамами. Включено по умолчанию, это исходное поведение приложения — выключите, если кнопка не нужна.",
    descriptionEn:
      "The \"Link in a circle\" button in the editor — quickly places transitions between all panoramas in a loop. On by default, this is the app's original behavior — turn off if you don't need the button.",
    defaultOn: true,
  },
  {
    id: "richNotes",
    label: "Богатые заметки",
    labelEn: "Rich notes",
    description:
      "Инфо-точки (без перехода на другую панораму) открывают карточку с описанием и фото вместо короткой всплывающей подписи на пару секунд.",
    descriptionEn:
      "Info points (without a transition to another panorama) open a card with a description and photo instead of a short popup label for a couple of seconds.",
    defaultOn: false,
  },
  {
    id: "linearChain",
    label: "Линейная цепочка переходов",
    labelEn: "Linear chain of transitions",
    description:
      "Кнопка «Связать по порядку» в редакторе — как «Связать по кругу», но без замыкания: для маршрута без цикла (труба, коридор, последовательность объектов).",
    descriptionEn:
      "The \"Link in order\" button in the editor — like \"Link in a circle\", but without closing the loop: for a route without a cycle (a pipe, a corridor, a sequence of sites).",
    defaultOn: false,
  },
  {
    id: "slideshow",
    label: "Автотур (слайд-шоу)",
    labelEn: "Auto tour (slideshow)",
    description:
      "Кнопка ▶ в самом туре — панорамы сами пролистываются по кругу с паузой между ними, для презентаций и киосков без оператора. Работает и в приложении, и в опубликованном туре.",
    descriptionEn:
      "The ▶ button inside the tour itself — panoramas advance on their own in a loop, with a pause between them, for presentations and unattended kiosks. Works both in the app and in the published tour.",
    defaultOn: false,
  },
  {
    id: "branding",
    label: "Брендинг тура",
    labelEn: "Tour branding",
    description:
      "Свой логотип и подпись в углу опубликованного тура (и в предпросмотре) — настраивается в этих же настройках, одна пара логотип+подпись на все туры.",
    descriptionEn:
      "Your own logo and caption in the corner of the published tour (and in the preview) — configured right here in settings, one logo+caption pair for all tours.",
    defaultOn: false,
  },
  {
    id: "qrCode",
    label: "QR-код тура",
    labelEn: "Tour QR code",
    description:
      "Кнопка «QR-код» в редакторе — вставляете ссылку на уже опубликованный тур (после загрузки экспорта на хостинг), получаете QR-код для печати в отчёте или на объекте. Генерируется прямо в браузере, без сети.",
    descriptionEn:
      "The \"QR code\" button in the editor — paste a link to an already published tour (after uploading the export to hosting), get a QR code to print in a report or on-site. Generated right in the browser, no network needed.",
    defaultOn: false,
  },
  {
    id: "compression",
    label: "Сжатие панорам при импорте",
    labelEn: "Compress panoramas on import",
    description:
      "Выбор качества при добавлении панорам — «Стандарт»/«Компактно» ужимают разрешение и JPEG-качество, чтобы тур с большим числом панорам весил меньше. По умолчанию — без доп. сжатия, как раньше.",
    descriptionEn:
      "A quality choice when adding panoramas — \"Standard\"/\"Compact\" shrink resolution and JPEG quality so a tour with many panoramas weighs less. Default — no extra compression, as before.",
    defaultOn: false,
  },
  {
    id: "dragReorder",
    label: "Перетаскивание панорам для сортировки",
    labelEn: "Drag panoramas to reorder",
    description:
      "Ручка ⠿ у каждой панорамы в списке — перетащите, чтобы переставить в любое место одним движением, вместо пошагового ↑/↓. Работает и мышью, и пальцем на телефоне.",
    descriptionEn:
      "A ⠿ handle on each panorama in the list — drag to move it anywhere in one motion, instead of stepping with ↑/↓. Works with a mouse and with a finger on a phone.",
    defaultOn: false,
  },
  {
    id: "i18n",
    label: "RU/EN тур",
    labelEn: "RU/EN tour",
    description:
      "Для каждой панорамы и подписи перехода можно задать английский вариант в редакторе; если не задан, показывается русский. Язык показа — общая настройка приложения (наверху этой страницы), в самом туре переключателя нет: экспорт всегда собирается на том языке, что выбран сейчас в приложении.",
    descriptionEn:
      "For each panorama and transition label you can set an English variant in the editor; if it's not set, Russian is shown. Display language is an app-wide setting (at the top of this page) — there's no switch inside the tour itself: export always bundles whatever language is currently selected in the app.",
    defaultOn: false,
  },
  {
    id: "projectBackup",
    label: "Резервная копия / перенос проекта",
    labelEn: "Project backup / transfer",
    description:
      "Кнопки «Копия» (скачать весь редактируемый проект — панорамы, переходы, заметки) и «Импортировать копию» на главном экране — перенос тура на другое устройство или в другой браузер, а не только просмотр готового экспорта.",
    descriptionEn:
      "The \"Backup\" button (download the whole editable project — panoramas, transitions, notes) and \"Import backup\" on the home screen — move a tour to another device or browser, not just view the finished export.",
    defaultOn: false,
  },
  {
    id: "map",
    label: "Карта тура",
    labelEn: "Tour map",
    description:
      "Загружаете план объекта (любая картинка) в редакторе и вручную расставляете на нём точки съёмки, перетаскивая. Кнопка «🗺️ Карта» появляется и в приложении, и в опубликованном туре — клик по точке переходит на нужную панораму.",
    descriptionEn:
      "Upload a site plan (any image) in the editor and manually place shooting points on it by dragging. A \"🗺️ Map\" button appears both in the app and in the published tour — clicking a point jumps to that panorama.",
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
