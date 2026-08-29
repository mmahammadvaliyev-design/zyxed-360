// Общая форма данных тура. Ей же описывается data.json в экспортированном туре —
// значит и приложение, и автономный плеер понимают один и тот же формат.

export interface Hotspot {
  id: string;
  yaw: number; // радианы
  pitch: number; // радианы
  label: string;
  targetId: string | null; // id сцены, куда переходим (null — просто подпись)
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
}
