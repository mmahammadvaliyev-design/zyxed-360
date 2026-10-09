import Dexie, { type Table } from "dexie";
import type { Hotspot, LineDef, SceneMeta } from "./engine/types";

export type { Hotspot };

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  // Функция «Карта тура»: план объекта (любая загруженная картинка), одна
  // на весь проект — точки съёмки расставляются по ней вручную (см.
  // SceneMeta.mapX/mapY в engine/types.ts).
  mapImage?: Blob;
  // Функция «Линии» (хайлайтер): линии тура — название и цвет; штрихи этих
  // линий лежат на панорамах (Scene.strokes).
  lines?: LineDef[];
}

// Одна панорама тура. Картинка и превью лежат прямо в базе как Blob —
// приложение работает офлайн, ничего никуда не отправляется.
export interface Scene extends SceneMeta {
  projectId: string;
  image: Blob;
  thumb: Blob;
}

// Привязка тура к папке на диске (см. folderSync.ts). Сам handle — объект
// браузера (File System Access API), IndexedDB умеет его хранить.
export interface FolderLink {
  projectId: string;
  handle: FileSystemDirectoryHandle;
  name: string;
  linkedAt: string;
}

// Подписчики на изменения проекта (folderSync.ts ставит сюда пересборку копии
// в папке) — отдельный список, а не импорт, чтобы db.ts не зависел от folderSync.
const changeListeners: Array<(projectId: string) => void> = [];
export function onProjectChanged(fn: (projectId: string) => void): void {
  changeListeners.push(fn);
}
function notifyChanged(projectId: string | undefined): void {
  if (!projectId) return;
  for (const fn of changeListeners) fn(projectId);
}

class ZyxedDB extends Dexie {
  projects!: Table<Project, string>;
  scenes!: Table<Scene, string>;
  folders!: Table<FolderLink, string>;

  constructor() {
    super("zyxed-360");
    this.version(1).stores({
      projects: "id, updatedAt",
      scenes: "id, projectId, order",
    });
    this.version(2).stores({
      projects: "id, updatedAt",
      scenes: "id, projectId, order",
      folders: "projectId",
    });
    this.scenes.hook("creating", (_pk, obj) => { notifyChanged(obj.projectId); });
    this.scenes.hook("updating", (_mods, _pk, obj) => { notifyChanged(obj.projectId); });
    this.scenes.hook("deleting", (_pk, obj) => { notifyChanged(obj.projectId); });
    this.projects.hook("creating", (_pk, obj) => { notifyChanged(obj.id); });
    this.projects.hook("updating", (_mods, pk) => { notifyChanged(String(pk)); });
  }
}

export const db = new ZyxedDB();

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function touchProject(id: string): Promise<void> {
  await db.projects.update(id, { updatedAt: nowIso() });
}

export async function createProject(title: string): Promise<Project> {
  const p: Project = { id: uid(), title, createdAt: nowIso(), updatedAt: nowIso() };
  await db.projects.put(p);
  return p;
}

// Названия туров должны быть уникальны (без учёта регистра/пробелов по краям),
// чтобы список туров не путал пользователя. Если базовое название занято,
// подбирает "База 2", "База 3"... excludeId — чтобы тур не конфликтовал сам с собой при переименовании.
export async function uniqueProjectTitle(base: string, excludeId?: string): Promise<string> {
  const trimmedBase = base.trim() || "Новый тур";
  const all = await db.projects.toArray();
  const taken = new Set(all.filter((p) => p.id !== excludeId).map((p) => p.title.trim().toLowerCase()));
  if (!taken.has(trimmedBase.toLowerCase())) return trimmedBase;
  let i = 2;
  while (taken.has(`${trimmedBase} ${i}`.toLowerCase())) i++;
  return `${trimmedBase} ${i}`;
}

export async function deleteProject(id: string): Promise<void> {
  await db.transaction("rw", db.projects, db.scenes, db.folders, async () => {
    await db.scenes.where("projectId").equals(id).delete();
    await db.projects.delete(id);
    await db.folders.delete(id); // файлы в самой папке на диске не удаляем — только связь
  });
}

// Полная копия проекта со всеми сценами (картинки — тем же Blob'ом, копировать
// байты незачем, IndexedDB хранит их по значению при put нового объекта).
export async function duplicateProject(id: string): Promise<Project> {
  const src = await db.projects.get(id);
  if (!src) throw new Error("Проект не найден");
  const scenes = await db.scenes.where("projectId").equals(id).toArray();
  const idMap = new Map(scenes.map((s) => [s.id, uid()]));
  const copyTitle = await uniqueProjectTitle(`${src.title} (копия)`);
  const copy: Project = { ...src, id: uid(), title: copyTitle, createdAt: nowIso(), updatedAt: nowIso() };
  await db.projects.put(copy);
  for (const s of scenes) {
    await db.scenes.put({
      ...s,
      id: idMap.get(s.id)!,
      projectId: copy.id,
      hotspots: s.hotspots.map((h) => ({ ...h, id: uid(), targetId: h.targetId ? idMap.get(h.targetId) ?? null : null })),
    });
  }
  return copy;
}
