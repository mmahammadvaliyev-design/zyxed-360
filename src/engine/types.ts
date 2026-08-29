// Общая форма данных тура. Ей же описывается data.json в экспортированном туре —
// значит и приложение, и автономный плеер понимают один и тот же формат.

export interface Hotspot {
  id: string;
  yaw: number; // радианы
  pitch: number; // радианы
  label: string;
  targetId: string | null; // id сцены, куда переходим (null — просто подпись)
  // Функция «Богатые заметки»: развёрнутое описание info-точки (без targetId).
  note?: string;
  // Фото крупным планом — храним как Blob в БД (photo) во время редактирования;
  // в экспортированном манифесте вместо него — data: URI (photoUrl), как и
  // с картинками сцен. Оба поля не встречаются вместе на одном объекте.
  photo?: Blob;
  photoUrl?: string;
}

export interface SceneMeta {
  id: string;
  title: string;
  width: number;
  height: number;
  order: number;
  yaw: number; // стартовый вид
  pitch: number;
  fov: number;
  hotspots: Hotspot[];
}

// Манифест экспортированного тура. Встраивается прямо в index.html плеера
// (id="tour-data"), картинки — как data: URI в images[sceneId]: так пакет
// открывается и двойным кликом с диска (браузеры блокируют fetch() локальных
// файлов по file://), и с любого статического хостинга — без отдельного
// запроса data.json/картинок.
export interface TourManifest {
  title: string;
  scenes: SceneMeta[];
  images: Record<string, string>;
  // Снимок состояния переключаемых функций на момент экспорта (см. src/features.ts) —
  // плеер должен вести себя так же, как приложение вело себя при публикации.
  features?: Record<string, boolean>;
  // Функция «Брендинг тура» (src/branding.ts) — логотип (data: URI) и подпись
  // в углу плеера. Присутствует, только если функция была включена при экспорте.
  branding?: { logo?: string; text?: string };
}
