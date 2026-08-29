import Dexie, { type Table } from "dexie";
import type { Hotspot, SceneMeta } from "./engine/types";

export type { Hotspot };

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// Одна панорама тура. Картинка и превью лежат прямо в базе как Blob —
// приложение работает офлайн, ничего никуда не отправляется.
export interface Scene extends SceneMeta {
  projectId: string;
  image: Blob;
  thumb: Blob;
}

class ZyxedDB extends Dexie {
  projects!: Table<Project, string>;
  scenes!: Table<Scene, string>;

  constructor() {
    super("zyxed-360");
    this.version(1).stores({
      projects: "id, updatedAt",
      scenes: "id, projectId, order",
    });
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

export async function deleteProject(id: string): Promise<void> {
  await db.transaction("rw", db.projects, db.scenes, async () => {
    await db.scenes.where("projectId").equals(id).delete();
    await db.projects.delete(id);
  });
}

// Полная копия проекта со всеми сценами (картинки — тем же Blob'ом, копировать
// байты незачем, IndexedDB хранит их по значению при put нового объекта).
export async function duplicateProject(id: string): Promise<Project> {
  const src = await db.projects.get(id);
  if (!src) throw new Error("Проект не найден");
  const scenes = await db.scenes.where("projectId").equals(id).toArray();
  const idMap = new Map(scenes.map((s) => [s.id, uid()]));
  const copy: Project = { ...src, id: uid(), title: `${src.title} (копия)`, createdAt: nowIso(), updatedAt: nowIso() };
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
