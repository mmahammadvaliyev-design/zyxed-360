// «Папка тура»: копия проекта на диске, которая обновляется автоматически.
//
// Данные тура по-прежнему живут в браузере (IndexedDB) — так программа
// работает на любом устройстве. Но если пользователь привязал тур к папке
// (File System Access API — только Chrome/Edge на компьютере), программа сама
// и без кнопок пишет туда копию проекта: ровно в том виде, в каком его
// собирает «Копия» (backup.json + images/ + thumbs/ + вложения), поэтому
// содержимое папки можно заархивировать и импортировать обратно, а готовые
// архивы для клиента (кнопка «Экспорт») складываются в подпапку export/.
//
// Папка — это КОПИЯ: правки файлов вне программы обратно не попадают.
import { useSyncExternalStore } from "react";
import { db, onProjectChanged } from "./db";
import { collectBackupEntries } from "./export/backup";

type DirHandle = FileSystemDirectoryHandle;
type AnyHandle = {
  queryPermission?: (d: { mode: string }) => Promise<string>;
  requestPermission?: (d: { mode: string }) => Promise<string>;
};

export const FOLDER_SUPPORTED =
  typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export type SyncState = "idle" | "syncing" | "synced" | "needs-permission" | "error";
export interface FolderStatus {
  linked: boolean;
  folderName: string;
  state: SyncState;
  syncedAt: string | null;
  error: string | null;
}
const NOT_LINKED: FolderStatus = { linked: false, folderName: "", state: "idle", syncedAt: null, error: null };

const statuses = new Map<string, FolderStatus>();
const handles = new Map<string, DirHandle>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}
function setStatus(projectId: string, patch: Partial<FolderStatus>) {
  const cur = statuses.get(projectId) ?? { ...NOT_LINKED };
  statuses.set(projectId, { ...cur, ...patch });
  emit();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useFolderStatus(projectId: string): FolderStatus {
  return useSyncExternalStore(subscribe, () => statuses.get(projectId) ?? NOT_LINKED);
}

// ── Разрешения ────────────────────────────────────────────────────

// Браузер забывает разрешение на папку после перезапуска — тогда нужен один
// клик «Разрешить» (requestPermission работает только по жесту пользователя).
async function queryPerm(dir: DirHandle): Promise<string> {
  const h = dir as unknown as AnyHandle;
  return typeof h.queryPermission === "function" ? h.queryPermission({ mode: "readwrite" }) : "granted";
}
async function requestPerm(dir: DirHandle): Promise<string> {
  const h = dir as unknown as AnyHandle;
  return typeof h.requestPermission === "function" ? h.requestPermission({ mode: "readwrite" }) : "granted";
}

// Нужно вызывать в самом начале обработчика клика (до долгих await), иначе
// «жест пользователя» уже истечёт и браузер откажет в запросе.
export async function ensureFolderAccess(projectId: string): Promise<boolean> {
  const dir = handles.get(projectId);
  if (!dir) return false;
  let perm = await queryPerm(dir);
  if (perm === "prompt") perm = await requestPerm(dir);
  if (perm === "granted") {
    if (statuses.get(projectId)?.state === "needs-permission") scheduleSync(projectId, 0);
    return true;
  }
  setStatus(projectId, { state: "needs-permission" });
  return false;
}

export async function grantFolderAccess(projectId: string): Promise<void> {
  await ensureFolderAccess(projectId);
}

// ── Выбор и создание папки ────────────────────────────────────────

export async function pickFolder(): Promise<DirHandle | null> {
  try {
    return await (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker({
      id: "zyxed360-tours", // браузер запоминает последнее место выбора
      mode: "readwrite",
    });
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return null;
    throw e;
  }
}

function safeFolderName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80) || "Тур"
  );
}

// Внутри выбранной папки создаётся подпапка с названием тура (если имя занято —
// «Название 2», «Название 3»…): чужие файлы и чужие папки не затрагиваются.
export async function createTourFolder(parent: DirHandle, title: string): Promise<DirHandle> {
  const base = safeFolderName(title);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    try {
      await parent.getDirectoryHandle(name);
      continue; // занято
    } catch (e) {
      if ((e as DOMException).name !== "NotFoundError") throw e;
    }
    return parent.getDirectoryHandle(name, { create: true });
  }
}

export async function linkProjectToFolder(projectId: string, dir: DirHandle): Promise<void> {
  await db.folders.put({ projectId, handle: dir, name: dir.name, linkedAt: new Date().toISOString() });
  handles.set(projectId, dir);
  setStatus(projectId, { linked: true, folderName: dir.name, state: "idle", error: null });
  scheduleSync(projectId, 0);
}

// Спрашивает папку у пользователя и привязывает к ней тур («Переместить в папку»).
export async function chooseFolderForProject(projectId: string, title: string): Promise<"linked" | "cancelled"> {
  const parent = await pickFolder();
  if (!parent) return "cancelled";
  const dir = await createTourFolder(parent, title);
  await linkProjectToFolder(projectId, dir);
  return "linked";
}

export async function forgetLink(projectId: string): Promise<void> {
  handles.delete(projectId);
  statuses.delete(projectId);
  const t = timers.get(projectId);
  if (t) clearTimeout(t);
  timers.delete(projectId);
  await db.folders.delete(projectId);
  emit();
}

// ── Запись файлов ─────────────────────────────────────────────────

async function dirFor(root: DirHandle, parts: string[]): Promise<DirHandle> {
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

async function writeFile(dir: DirHandle, name: string, data: Blob | Uint8Array): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as unknown as { createWritable: () => Promise<{ write: (d: unknown) => Promise<void>; close: () => Promise<void> }> }).createWritable();
  await w.write(data);
  await w.close();
}

// Картинки и вложения в проекте неизменяемы (по id) — если файл такого же
// размера уже лежит в папке, повторно не пишем (экономит диск и время).
async function writeIfChanged(root: DirHandle, path: string, data: Blob): Promise<void> {
  const parts = path.split("/");
  const name = parts.pop()!;
  const dir = await dirFor(root, parts);
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    if (f.size === data.size) return;
  } catch (e) {
    if ((e as DOMException).name !== "NotFoundError") throw e;
  }
  await writeFile(dir, name, data);
}

async function writeTextIfChanged(dir: DirHandle, name: string, bytes: Uint8Array): Promise<void> {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    const cur = new Uint8Array(await f.arrayBuffer());
    if (cur.length === bytes.length && cur.every((b, i) => b === bytes[i])) return;
  } catch (e) {
    if ((e as DOMException).name !== "NotFoundError") throw e;
  }
  await writeFile(dir, name, bytes);
}

// Папки, которыми управляет программа: лишние (удалённые из тура) файлы в них
// убираем, чтобы папка была точной копией. Подпапка export/ и любые другие
// файлы пользователя НЕ трогаем.
const MANAGED_DIRS = ["images", "thumbs", "hotspotPhotos", "hotspotFiles", "lineFiles"];

async function prune(root: DirHandle, keep: Set<string>): Promise<void> {
  for (const dirName of MANAGED_DIRS) {
    let d: DirHandle;
    try {
      d = await root.getDirectoryHandle(dirName);
    } catch {
      continue;
    }
    const names: string[] = [];
    for await (const [name, h] of (d as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === "file" && !keep.has(`${dirName}/${name}`)) names.push(name);
    }
    for (const n of names) await d.removeEntry(n);
  }
  if (!keep.has("map.jpg")) {
    try {
      await root.removeEntry("map.jpg");
    } catch {
      /* файла нет — и хорошо */
    }
  }
}

const README = `Папка тура — Zyxed 360
======================

Эту папку создала программа Zyxed 360 и обновляет её сама при каждой правке тура.

backup.json                 — описание тура (панорамы, переходы, линии, документация)
images/, thumbs/            — панорамы и их превью
hotspotPhotos/,
hotspotFiles/, lineFiles/   — фото и вложения заметок и линий (модели, изометрии, PDF)
map.jpg                     — план объекта (если есть)
export/                     — готовые архивы для клиента (кнопка «Экспорт»)

Это КОПИЯ: правки файлов вне программы обратно в тур не попадают.
Чтобы восстановить тур: заархивируйте содержимое папки (без export/) в ZIP и
импортируйте кнопкой «Импортировать копию» на главном экране.
`;

// ── Синхронизация ─────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
const again = new Set<string>();

export function scheduleSync(projectId: string, delayMs = 2000): void {
  if (!handles.has(projectId)) return;
  const prev = timers.get(projectId);
  if (prev) clearTimeout(prev);
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      void runSync(projectId);
    }, delayMs),
  );
}

async function runSync(projectId: string): Promise<void> {
  const dir = handles.get(projectId);
  if (!dir) return;
  if (running.has(projectId)) {
    again.add(projectId); // правки пришли во время записи — повторим сразу после
    return;
  }
  running.add(projectId);
  setStatus(projectId, { state: "syncing", error: null });
  try {
    if ((await queryPerm(dir)) !== "granted") {
      setStatus(projectId, { state: "needs-permission" });
      return;
    }
    const project = await db.projects.get(projectId);
    if (!project) return;
    const plan = await collectBackupEntries(projectId, true);
    const keep = new Set(plan.entries.map((e) => e.path));
    for (const e of plan.entries) await writeIfChanged(dir, e.path, e.blob);
    await writeTextIfChanged(dir, "backup.json", plan.manifest);
    await writeTextIfChanged(dir, "README.txt", new TextEncoder().encode(README));
    await prune(dir, keep);
    setStatus(projectId, { state: "synced", syncedAt: new Date().toISOString(), error: null });
  } catch (e) {
    setStatus(projectId, { state: "error", error: (e as Error).message || String(e) });
  } finally {
    running.delete(projectId);
    if (again.delete(projectId)) scheduleSync(projectId, 300);
  }
}

export async function syncNow(projectId: string): Promise<void> {
  const t = timers.get(projectId);
  if (t) clearTimeout(t);
  timers.delete(projectId);
  await runSync(projectId);
}

// ── Экспорт для клиента → в подпапку export/ ───────────────────────

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Кладёт готовый архив в <папка тура>/export/<имя>_<дата>.zip; возвращает
// путь для показа пользователю или null, если папки нет/нет доступа.
export async function saveExportToFolder(projectId: string, blob: Blob, filename: string): Promise<string | null> {
  const dir = handles.get(projectId);
  if (!dir || (await queryPerm(dir)) !== "granted") return null;
  const base = filename.replace(/\.zip$/i, "");
  const name = `${base}_${stamp()}.zip`;
  const exp = await dir.getDirectoryHandle("export", { create: true });
  await writeFile(exp, name, blob);
  return `${dir.name}\\export\\${name}`;
}

// ── Старт: восстановить привязки и догнать копию ───────────────────

onProjectChanged((projectId) => scheduleSync(projectId));

async function init(): Promise<void> {
  if (!FOLDER_SUPPORTED) return;
  try {
    const links = await db.folders.toArray();
    for (const l of links) {
      handles.set(l.projectId, l.handle);
      setStatus(l.projectId, { linked: true, folderName: l.name, state: "idle" });
      const perm = await queryPerm(l.handle);
      if (perm === "granted") scheduleSync(l.projectId, 1500);
      else setStatus(l.projectId, { state: "needs-permission" });
    }
  } catch {
    /* хранилище недоступно — папки просто не подхватятся */
  }
}
void init();
