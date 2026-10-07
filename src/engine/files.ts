// Вложения к заметкам («Богатые заметки»): любой файл, который зритель может
// скачать — PDF, чертёж DWG/DXF, 3D-модель и т.п. Поле в данных исторически
// называется `pdfs` (Hotspot.pdfs) — переименовывать нельзя, иначе пропадут
// уже сохранённые у пользователей PDF; по смыслу это «вложения».
// Общий модуль: им пользуются и приложение, и автономный плеер.

// Файл едет внутри index.html как data: URI (+33%), поэтому размер ограничен.
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

// Исполняемые/скриптовые файлы не принимаем: тур публикуется для чужих
// людей, и скачивание .exe из карточки заметки — не то, чего ждёт зритель.
const BLOCKED_EXT = new Set(["exe", "msi", "bat", "cmd", "com", "scr", "js", "vbs", "ps1", "jar", "apk", "dll", "lnk", "html", "htm", "svg"]);

export function fileExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

// null — файл подходит; иначе причина отказа.
export function checkAttachment(file: File): "blocked" | "too-big" | "empty" | null {
  if (BLOCKED_EXT.has(fileExt(file.name))) return "blocked";
  if (file.size === 0) return "empty";
  if (file.size > ATTACHMENT_MAX_BYTES) return "too-big";
  return null;
}

const MODEL_EXT = new Set(["glb", "gltf", "obj", "fbx", "stl", "step", "stp", "iges", "igs", "ifc", "rvt", "skp", "3ds", "dae", "usdz", "3dm", "blend", "ply", "e57", "las", "laz", "rcp", "rcs"]);
const CAD_EXT = new Set(["dwg", "dxf", "dwf", "dgn"]);
const SHEET_EXT = new Set(["xls", "xlsx", "csv"]);
const DOC_EXT = new Set(["doc", "docx", "txt", "rtf", "ppt", "pptx"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp"]);

export function fileIcon(name: string): string {
  const ext = fileExt(name);
  if (ext === "pdf") return "📄";
  if (CAD_EXT.has(ext)) return "📐";
  if (MODEL_EXT.has(ext)) return "🧊";
  if (SHEET_EXT.has(ext)) return "📊";
  if (DOC_EXT.has(ext)) return "📝";
  if (IMG_EXT.has(ext)) return "🖼";
  if (ext === "zip" || ext === "rar" || ext === "7z") return "🗜";
  return "📎";
}

// MIME для Blob при скачивании/восстановлении: PDF узнаём по расширению,
// всё остальное — нейтральный octet-stream (браузер скачает, а не откроет).
export function mimeForName(name: string): string {
  return fileExt(name) === "pdf" ? "application/pdf" : "application/octet-stream";
}
