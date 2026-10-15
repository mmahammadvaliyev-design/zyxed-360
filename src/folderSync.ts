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
import { collectBackupEntries, importBackupFiles } from "./export/backup";
import { buildTourFiles } from "./export/bundle";
import { collectDocumentEntries, DOCS_ROOT } from "./export/documents";

type DirHandle = FileSystemDirectoryHandle;
type AnyHandle = {
  queryPermission?: (d: { mode: string }) => Promise<string>;
  requestPermission?: (d: { mode: string }) => Promise<string>;
};

export const FOLDER_SUPPORTED =
  typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export type SyncState = "idle" | "syncing" | "synced" | "needs-permission" | "conflict" | "error";
export interface FolderStatus {
  linked: boolean;
  folderName: string;
  state: SyncState;
  syncedAt: string | null;
  error: string | null;
  // «Просмотровый» index.html в папке: когда обновлён и идёт ли сборка.
  viewerAt: string | null;
  viewerBusy: boolean;
  viewerError: string | null;
}
const NOT_LINKED: FolderStatus = { linked: false, folderName: "", state: "idle", syncedAt: null, error: null, viewerAt: null, viewerBusy: false, viewerError: null };

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

async function folderBackupMtime(dir: DirHandle): Promise<number | null> {
  try {
    return (await (await dir.getFileHandle("backup.json")).getFile()).lastModified;
  } catch {
    return null;
  }
}

export async function linkProjectToFolder(projectId: string, dir: DirHandle, knownMtime?: number | null): Promise<void> {
  const mtime = knownMtime !== undefined ? knownMtime : await folderBackupMtime(dir);
  await db.folders.put({ projectId, handle: dir, name: dir.name, linkedAt: new Date().toISOString(), ...(mtime !== null ? { backupMtime: mtime } : {}) });
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

// ── «Открыть тур из папки» ────────────────────────────────────────
// Тур живёт в браузере, а папка — его копия. Если браузер очищен, данные
// перенесены на другой компьютер или просто нужно продолжить работу из папки,
// программа читает папку тура (backup.json + images/ …) и поднимает из неё
// тур — без архивирования и ручного «Импортировать копию».

export interface PickedTourFolder {
  dir: DirHandle;
  existingProjectId: string | null; // тур, уже привязанный к этой папке в программе
}

async function hasFile(dir: DirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// Просит выбрать папку тура. Если выбрана папка, ВНУТРИ которой лежит одна
// папка тура (например «360-Tour» с «Wet-Oil»), берём её сами.
export async function pickTourFolder(): Promise<PickedTourFolder | null> {
  let dir = await pickFolder();
  if (!dir) return null;
  if (!(await hasFile(dir, "backup.json"))) {
    const found: DirHandle[] = [];
    for await (const [, h] of (dir as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === "directory" && (await hasFile(h as DirHandle, "backup.json"))) found.push(h as DirHandle);
    }
    if (found.length === 1) dir = found[0];
    else if (found.length > 1) throw new Error(`В выбранной папке несколько туров (${found.map((f) => f.name).join(", ")}). Выберите папку нужного тура.`);
    else throw new Error("В этой папке нет backup.json — это не папка тура Zyxed 360. Выберите папку самого тура.");
  }
  let existing: string | null = null;
  for (const row of await db.folders.toArray()) {
    try {
      if (await (row.handle as unknown as { isSameEntry: (o: FileSystemHandle) => Promise<boolean> }).isSameEntry(dir)) {
        if (await db.projects.get(row.projectId)) existing = row.projectId;
        break;
      }
    } catch {
      /* handle не открывается — пропускаем */
    }
  }
  return { dir, existingProjectId: existing };
}

// Тур уже в программе: обновляем доступ к папке (свежий handle из выбора уже с
// правом записи) и продолжаем автосохранение.
export async function relinkExisting(projectId: string, dir: DirHandle): Promise<void> {
  const prev = await db.folders.get(projectId);
  await db.folders.put({ projectId, handle: dir, name: dir.name, linkedAt: new Date().toISOString(), ...(prev?.backupMtime !== undefined ? { backupMtime: prev.backupMtime } : {}) });
  handles.set(projectId, dir);
  setStatus(projectId, { linked: true, folderName: dir.name, state: "idle", error: null });
  scheduleSync(projectId, 1500);
}

const READ_DIRS = ["thumbs", "hotspotPhotos", "hotspotFiles", "hotspotPdfs", "lineFiles"];

async function readFolderFiles(dir: DirHandle): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const read = async (d: DirHandle, prefix: string) => {
    for await (const [name, h] of (d as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === "file") files[prefix + name] = new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
    }
  };
  let images: DirHandle;
  try {
    images = await dir.getDirectoryHandle("images");
  } catch {
    throw new Error("В папке тура нет подпапки images/ — панорамы не найдены.");
  }
  await read(images, "images/");
  for (const name of READ_DIRS) {
    try {
      await read(await dir.getDirectoryHandle(name), name + "/");
    } catch {
      /* подпапки может не быть (нет заметок/линий) */
    }
  }
  for (const name of ["backup.json", "map.jpg"]) {
    try {
      files[name] = new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
    } catch {
      if (name === "backup.json") throw new Error("В папке нет backup.json.");
    }
  }
  return files;
}

// Поднимает тур из папки. link=true — привязывает его к этой же папке, чтобы
// автосохранение продолжилось туда же; false — просто загружает отдельной копией.
export async function importTourFromFolder(dir: DirHandle, link: boolean): Promise<string> {
  const mtime = await folderBackupMtime(dir);
  const project = await importBackupFiles(await readFolderFiles(dir), { keepIds: true });
  if (link) await linkProjectToFolder(project.id, dir, mtime);
  return project.id;
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

// ── «Просмотровый» index.html в самой папке тура ──
// Рядом с копией проекта лежит готовый тур (index.html + assets/): открыл папку,
// дважды щёлкнул — смотришь актуальный тур без программы и без ручного
// «Экспорта». Обновляется сам, но не на каждую правку, а когда авторы
// «затихли» (сборка — это перекодирование всех панорам, она тяжелее копии).
const VIEWER_DELAY_MS = 20_000;
const viewerTimers = new Map<string, ReturnType<typeof setTimeout>>();
const viewerRunning = new Set<string>();
const viewerAgain = new Set<string>();

export function scheduleViewer(projectId: string, delayMs = VIEWER_DELAY_MS): void {
  if (!handles.has(projectId)) return;
  const prev = viewerTimers.get(projectId);
  if (prev) clearTimeout(prev);
  viewerTimers.set(
    projectId,
    setTimeout(() => {
      viewerTimers.delete(projectId);
      void runViewer(projectId);
    }, delayMs),
  );
}

const viewerBuilt = new Map<string, string>(); // projectId → project.updatedAt, при котором index.html уже собран в этой сессии

async function runViewer(projectId: string, force = false): Promise<void> {
  const dir = handles.get(projectId);
  if (!dir) return;
  if (viewerRunning.has(projectId)) {
    viewerAgain.add(projectId);
    return;
  }
  viewerRunning.add(projectId);
  setStatus(projectId, { viewerBusy: true });
  try {
    if ((await queryPerm(dir)) !== "granted") return;
    if (statuses.get(projectId)?.state === "conflict") return; // папка с чужими изменениями — не трогаем
    const stamp0 = (await db.projects.get(projectId))?.updatedAt ?? "";
    if (!force && viewerBuilt.get(projectId) === stamp0) return; // тур не менялся — пересобирать незачем
    let built;
    try {
      built = await buildTourFiles(projectId);
    } catch (e) {
      // нет панорам — просматривать нечего; остальное (например, слишком большой тур) покажем
      if (!/нет ни одной панорамы/.test((e as Error).message)) setStatus(projectId, { viewerError: (e as Error).message || String(e) });
      return;
    }
    for (const [path, bytes] of Object.entries(built.files)) {
      const parts = path.split("/");
      const name = parts.pop()!;
      await writeTextIfChanged(await dirFor(dir, parts), name, bytes);
    }
    // старые версии файлов плеера (хэшированные имена) убираем из assets/
    try {
      const assets = await dir.getDirectoryHandle("assets");
      const stale: string[] = [];
      for await (const [name, h] of (assets as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind === "file" && !(`assets/${name}` in built.files)) stale.push(name);
      }
      for (const n of stale) await assets.removeEntry(n);
    } catch {
      /* папки assets ещё нет */
    }
    viewerBuilt.set(projectId, stamp0);
    setStatus(projectId, { viewerAt: new Date().toISOString(), viewerError: null });
  } catch (e) {
    console.warn("[folderSync] не удалось обновить index.html тура:", e);
    setStatus(projectId, { viewerError: (e as Error).message || String(e) });
  } finally {
    viewerRunning.delete(projectId);
    setStatus(projectId, { viewerBusy: false });
    if (viewerAgain.delete(projectId)) scheduleViewer(projectId, 2000);
  }
}

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

// ── «Документы»: читаемая раскладка файлов по названиям труб/заметок ──
// Что программа записала в Документы/ — перечислено в .zyxed-index.json. Удаляем
// при обновлении ТОЛЬКО то, что есть в этом списке (файл убрали из тура или
// переименовали линию), поэтому чужие файлы, которые вы положили в эти папки,
// программа не трогает.
const DOCS_INDEX = ".zyxed-index.json";

async function removeFileAndEmptyDirs(root: DirHandle, path: string): Promise<void> {
  const parts = path.split("/");
  const name = parts.pop()!;
  const chain: DirHandle[] = [root];
  try {
    for (const part of parts) chain.push(await chain[chain.length - 1].getDirectoryHandle(part));
    await chain[chain.length - 1].removeEntry(name);
  } catch {
    return; // уже нет — и хорошо
  }
  // пустые подпапки убираем снизу вверх, но не сами «Документы/Линии» и «Документы/Заметки»
  for (let i = chain.length - 1; i >= 3; i--) {
    let empty = true;
    for await (const _ of (chain[i] as unknown as { keys: () => AsyncIterable<string> }).keys()) {
      empty = false;
      break;
    }
    if (!empty) break;
    try {
      await chain[i - 1].removeEntry(parts[i - 1]);
    } catch {
      break;
    }
  }
}

async function syncDocuments(root: DirHandle, projectId: string): Promise<void> {
  const entries = await collectDocumentEntries(projectId);
  const docsDir = await dirFor(root, [DOCS_ROOT]);
  let prev: string[] = [];
  try {
    const f = await (await docsDir.getFileHandle(DOCS_INDEX)).getFile();
    const parsed: unknown = JSON.parse(await f.text());
    if (Array.isArray(parsed)) prev = parsed.filter((x): x is string => typeof x === "string" && x.startsWith(`${DOCS_ROOT}/`) && !x.includes(".."));
  } catch {
    /* первого списка ещё нет */
  }
  const now = new Set(entries.map((e) => e.path));
  for (const e of entries) {
    if (e.blob) await writeIfChanged(root, e.path, e.blob);
    else {
      const parts = e.path.split("/");
      const name = parts.pop()!;
      await writeTextIfChanged(await dirFor(root, parts), name, new TextEncoder().encode(e.text ?? ""));
    }
  }
  for (const old of prev) if (!now.has(old)) await removeFileAndEmptyDirs(root, old);
  await writeTextIfChanged(docsDir, DOCS_INDEX, new TextEncoder().encode(JSON.stringify([...now])));
}

const README = `Папка тура — Zyxed 360
======================

Эту папку создала программа Zyxed 360 и обновляет её сама при каждой правке тура.

backup.json                 — описание тура (панорамы, переходы, линии, документация)
images/, thumbs/            — панорамы и их превью
hotspotPhotos/,
hotspotFiles/, lineFiles/   — служебные копии фото и вложений (по ним программа восстанавливает тур)
Документы/                  — ТО, ЧТО НУЖНО ВАМ: файлы линий и заметок под своими именами,
                              по папкам с названием трубы (Документы/Линии/<труба>/…).
                              Берите чертёж прямо отсюда, не открывая тур
map.jpg                     — план объекта (если есть)
index.html, assets/         — ГОТОВЫЙ ТУР для просмотра: откройте index.html двойным щелчком
                              (без программы и интернета). Обновляется сам через ~20 секунд
                              после последней правки — всегда актуальная версия
export/                     — готовые архивы для клиента (кнопка «Экспорт»)

Это КОПИЯ: правки файлов вне программы обратно в тур не попадают.
Чтобы восстановить тур: кнопка «Копия» в программе, либо заархивируйте в ZIP всё,
кроме index.html, assets/, Документы/ и export/, и импортируйте кнопкой
«Импортировать копию» на главном экране.
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
    if (!project) {
      setStatus(projectId, { state: "idle" });
      return;
    }
    // Папку правили снаружи (другой компьютер, восстановление из архива)? Тогда её не
    // перезаписываем молча — пользователь решает, чья версия главнее.
    const link = await db.folders.get(projectId);
    const mtimeNow = await folderBackupMtime(dir);
    if (link?.backupMtime !== undefined && mtimeNow !== null && mtimeNow !== link.backupMtime) {
      setStatus(projectId, { state: "conflict" });
      return;
    }
    const plan = await collectBackupEntries(projectId, true);
    const keep = new Set(plan.entries.map((e) => e.path));
    for (const e of plan.entries) await writeIfChanged(dir, e.path, e.blob);
    await writeTextIfChanged(dir, "backup.json", plan.manifest);
    await writeTextIfChanged(dir, "README.txt", new TextEncoder().encode(README));
    await prune(dir, keep);
    await syncDocuments(dir, projectId);
    const written = await folderBackupMtime(dir);
    if (written !== null) await db.folders.update(projectId, { backupMtime: written });
    setStatus(projectId, { state: "synced", syncedAt: new Date().toISOString(), error: null });
    scheduleViewer(projectId);
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
  // ручная синхронизация («Повторить»/сразу после привязки) — и просмотр обновляем сразу
  const vt = viewerTimers.get(projectId);
  if (vt) clearTimeout(vt);
  viewerTimers.delete(projectId);
  await runViewer(projectId, true);
}

// Конфликт: в папке есть изменения не от этой программы.
// 1) «Заменить папку моей версией» — принимаем текущее состояние папки как известное и пишем поверх.
export async function resolveConflictOverwrite(projectId: string): Promise<void> {
  const dir = handles.get(projectId);
  if (!dir) return;
  const m = await folderBackupMtime(dir);
  if (m !== null) await db.folders.update(projectId, { backupMtime: m });
  setStatus(projectId, { state: "idle" });
  await syncNow(projectId);
}
// 2) «Загрузить версию из папки отдельным туром» — тур из папки без привязки к ней.
export async function resolveConflictImport(projectId: string): Promise<string | null> {
  const dir = handles.get(projectId);
  if (!dir) return null;
  return importTourFromFolder(dir, false);
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
