// Резервная копия / перенос всего РЕДАКТИРУЕМОГО проекта — не готовый тур
// для просмотра (см. bundle.ts), а исходники: панорамы в полном разрешении,
// миниатюры, все поля хотспотов (переходы, заметки, фото), чтобы можно было
// продолжить работу над туром на другом устройстве или в другом браузере,
// а не только посмотреть уже опубликованный результат.
import { mimeForName } from "../engine/files";
import type { LineDef, NotePdf, Stroke } from "../engine/types";
import { unzipSync, zipSync } from "fflate";
import { createProject, db, uid, uniqueProjectTitle, type Hotspot, type Project } from "../db";
import { slugify } from "./bundle";

const BACKUP_VERSION = 1;

interface BackupHotspot extends Omit<Hotspot, "photo" | "pdfs"> {
  pdfRefs?: { name: string; ref?: string; href?: string }[]; // вложения заметки (любые файлы): имя + путь в архиве (старые копии — hotspotPdfs/…, читаются по ref)
  photoRef?: string; // путь внутри архива, если у заметки есть фото
}
// Линия с документацией: фото/файлы лежат в архиве отдельными файлами.
interface BackupLine extends Omit<LineDef, "photo" | "pdfs"> {
  photoRef?: string;
  pdfRefs?: { name: string; ref?: string; href?: string }[];
}
interface BackupScene {
  id: string;
  title: string;
  width: number;
  height: number;
  order: number;
  yaw: number;
  pitch: number;
  fov: number;
  hotspots: BackupHotspot[];
  mapX?: number;
  strokes?: Stroke[];
  lineWidths?: Record<string, number>;
  mapY?: number;
}
interface BackupManifest {
  version: number;
  title: string;
  scenes: BackupScene[];
  lines?: BackupLine[]; // функция «Линии»
  hasMapImage?: boolean; // план объекта, если был — файл map.jpg в архиве
}

// Имя вложения безопасно для файловой системы (оно попадает в путь внутри архива
// и папки тура, чтобы файлы можно было узнать глазами и открыть напрямую).
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 80) || "file";
}

export interface BackupEntry {
  path: string;
  blob: Blob;
}

// Всё, из чего состоит копия проекта: описание (backup.json) и файлы-Blob'ы.
// Blob'ы не читаются в память — их потребитель (ZIP или запись в папку) берёт сам.
export async function collectBackupEntries(
  projectId: string,
  allowEmpty = false,
): Promise<{ title: string; manifest: Uint8Array; entries: BackupEntry[] }> {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error("Проект не найден");
  const scenes = await db.scenes.where("projectId").equals(projectId).sortBy("order");
  if (!scenes.length && !allowEmpty) throw new Error("В туре нет ни одной панорамы — копировать нечего.");

  const entries: BackupEntry[] = [];
  const backupScenes: BackupScene[] = [];
  for (const s of scenes) {
    entries.push({ path: `images/${s.id}.jpg`, blob: s.image });
    entries.push({ path: `thumbs/${s.id}.jpg`, blob: s.thumb });
    const hotspots: BackupHotspot[] = [];
    for (const h of s.hotspots) {
      const { photo, pdfs, ...rest } = h;
      let photoRef: string | undefined;
      if (photo) {
        photoRef = `hotspotPhotos/${h.id}.jpg`;
        entries.push({ path: photoRef, blob: photo });
      }
      const pdfRefs: { name: string; ref?: string; href?: string }[] = [];
      for (const [i, p] of (pdfs ?? []).entries()) {
        if (p.href) { pdfRefs.push({ name: p.name, href: p.href }); continue; }
        if (!p.data) continue;
        const ref = `hotspotFiles/${h.id}-${i}-${safeFileName(p.name)}`;
        entries.push({ path: ref, blob: p.data });
        pdfRefs.push({ name: p.name, ref });
      }
      hotspots.push({ ...rest, photoRef, pdfRefs: pdfRefs.length ? pdfRefs : undefined });
    }
    backupScenes.push({
      id: s.id,
      title: s.title,
      width: s.width,
      height: s.height,
      order: s.order,
      yaw: s.yaw,
      pitch: s.pitch,
      fov: s.fov,
      hotspots,
      mapX: s.mapX,
      mapY: s.mapY,
      strokes: s.strokes?.length ? s.strokes : undefined,
      lineWidths: s.lineWidths && Object.keys(s.lineWidths).length ? s.lineWidths : undefined,
    });
  }

  if (project.mapImage) entries.push({ path: "map.jpg", blob: project.mapImage });

  const backupLines: BackupLine[] = [];
  for (const l of project.lines ?? []) {
    const { photo, pdfs, ...rest } = l;
    let photoRef: string | undefined;
    if (photo) {
      photoRef = `lineFiles/${l.id}-photo`;
      entries.push({ path: photoRef, blob: photo });
    }
    const pdfRefs: { name: string; ref?: string; href?: string }[] = [];
    for (const [i, p] of (pdfs ?? []).entries()) {
      if (p.href) {
        pdfRefs.push({ name: p.name, href: p.href });
        continue;
      }
      if (!p.data) continue;
      const ref = `lineFiles/${l.id}-${i}-${safeFileName(p.name)}`;
      entries.push({ path: ref, blob: p.data });
      pdfRefs.push({ name: p.name, ref });
    }
    backupLines.push({ ...rest, photoRef, pdfRefs: pdfRefs.length ? pdfRefs : undefined });
  }

  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    title: project.title,
    scenes: backupScenes,
    hasMapImage: !!project.mapImage,
    lines: backupLines.length ? backupLines : undefined,
  };
  return { title: project.title, manifest: new TextEncoder().encode(JSON.stringify(manifest)), entries };
}

export async function exportProjectBackup(projectId: string): Promise<{ blob: Blob; filename: string }> {
  const { title, manifest, entries } = await collectBackupEntries(projectId);
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) files[e.path] = new Uint8Array(await e.blob.arrayBuffer());
  files["backup.json"] = manifest;
  const zipped = zipSync(files, { level: 6 });
  return { blob: new Blob([zipped], { type: "application/zip" }), filename: `${slugify(title)}-backup.zip` };
}

// Импорт всегда создаёт новый проект с новыми id (даже если это тот же файл,
// импортированный второй раз) — переносить в существующий проект незачем,
// а совпадение id было бы риском перезаписать чужие данные.
export async function importProjectBackup(file: Blob): Promise<Project> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("Не удалось прочитать файл — это не ZIP-архив.");
  }
  const manifestRaw = files["backup.json"];
  if (!manifestRaw) throw new Error("Это не похоже на резервную копию Zyxed 360 — нет backup.json.");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as BackupManifest;
  } catch {
    throw new Error("Файл резервной копии повреждён.");
  }
  if (manifest.version !== BACKUP_VERSION) throw new Error("Неподдерживаемая версия резервной копии.");
  if (!manifest.scenes?.length) throw new Error("В резервной копии нет панорам.");

  const title = await uniqueProjectTitle(manifest.title || "Импортированный тур");
  const project = await createProject(title);
  const idMap = new Map(manifest.scenes.map((s) => [s.id, uid()]));

  if (manifest.lines?.length) {
    const restored: LineDef[] = manifest.lines.map((l) => {
      const { photoRef, pdfRefs, ...rest } = l;
      const photoBytes = photoRef ? files[photoRef] : undefined;
      const pdfs = (pdfRefs ?? []).flatMap((p): NotePdf[] => {
        if (p.href) return [{ name: p.name, href: p.href }];
        const bytes = p.ref ? files[p.ref] : undefined;
        return bytes ? [{ name: p.name, data: new Blob([new Uint8Array(bytes)], { type: mimeForName(p.name) }) }] : [];
      });
      return {
        ...rest,
        photo: photoBytes ? new Blob([new Uint8Array(photoBytes)], { type: "image/jpeg" }) : undefined,
        pdfs: pdfs.length ? pdfs : undefined,
      };
    });
    await db.projects.update(project.id, { lines: restored });
  }
  if (manifest.hasMapImage) {
    const mapBytes = files["map.jpg"];
    if (mapBytes) await db.projects.update(project.id, { mapImage: new Blob([new Uint8Array(mapBytes)], { type: "image/jpeg" }) });
  }

  for (const s of manifest.scenes) {
    const imgBytes = files[`images/${s.id}.jpg`];
    const thumbBytes = files[`thumbs/${s.id}.jpg`];
    if (!imgBytes || !thumbBytes) continue;
    const hotspots: Hotspot[] = s.hotspots.map((h) => {
      const { photoRef, pdfRefs, ...rest } = h;
      const photoBytes = photoRef ? files[photoRef] : undefined;
      const pdfs = (pdfRefs ?? []).flatMap((p): NotePdf[] => {
        if (p.href) return [{ name: p.name, href: p.href }];
        const bytes = p.ref ? files[p.ref] : undefined;
        return bytes ? [{ name: p.name, data: new Blob([new Uint8Array(bytes)], { type: mimeForName(p.name) }) }] : [];
      });
      return {
        ...rest,
        id: uid(),
        targetId: h.targetId ? idMap.get(h.targetId) ?? null : null,
        photo: photoBytes ? new Blob([new Uint8Array(photoBytes)], { type: "image/jpeg" }) : undefined,
        pdfs: pdfs.length ? pdfs : undefined,
      };
    });
    await db.scenes.put({
      id: idMap.get(s.id)!,
      projectId: project.id,
      title: s.title,
      image: new Blob([new Uint8Array(imgBytes)], { type: "image/jpeg" }),
      thumb: new Blob([new Uint8Array(thumbBytes)], { type: "image/jpeg" }),
      width: s.width,
      height: s.height,
      order: s.order,
      yaw: s.yaw,
      pitch: s.pitch,
      fov: s.fov,
      hotspots,
      mapX: s.mapX,
      mapY: s.mapY,
      strokes: s.strokes?.length ? s.strokes.map((st) => ({ ...st, id: uid() })) : undefined,
      lineWidths: s.lineWidths,
    });
  }
  return project;
}
