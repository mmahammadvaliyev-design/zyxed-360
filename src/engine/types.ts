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

// Манифест экспортированного тура (data.json рядом с плеером). Картинка сцены —
// файл images/<id>.jpg рядом с манифестом.
export interface TourManifest {
  title: string;
  scenes: SceneMeta[];
}
