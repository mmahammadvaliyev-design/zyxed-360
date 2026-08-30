// Резервная копия / перенос всего РЕДАКТИРУЕМОГО проекта — не готовый тур
// для просмотра (см. bundle.ts), а исходники: панорамы в полном разрешении,
// миниатюры, все поля хотспотов (переходы, заметки, фото), чтобы можно было
// продолжить работу над туром на другом устройстве или в другом браузере,
// а не только посмотреть уже опубликованный результат.
import { unzipSync, zipSync } from "fflate";
import { createProject, db, uid, uniqueProjectTitle, type Hotspot, type Project } from "../db";
import { slugify } from "./bundle";

const BACKUP_VERSION = 1;

interface BackupHotspot extends Omit<Hotspot, "photo"> {
  photoRef?: string; // путь внутри архива, если у заметки есть фото
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
  mapY?: number;
}
interface BackupManifest {
  version: number;
  title: string;
  scenes: BackupScene[];
  hasMapImage?: boolean; // план объекта, если был — файл map.jpg в архиве
}

export async function exportProjectBackup(projectId: string): Promise<{ blob: Blob; filename: string }> {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error("Проект не найден");
  const scenes = await db.scenes.where("projectId").equals(projectId).sortBy("order");
  if (!scenes.length) throw new Error("В туре нет ни одной панорамы — копировать нечего.");

  const files: Record<string, Uint8Array> = {};
  const backupScenes: BackupScene[] = [];
  for (const s of scenes) {
    files[`images/${s.id}.jpg`] = new Uint8Array(await s.image.arrayBuffer());
    files[`thumbs/${s.id}.jpg`] = new Uint8Array(await s.thumb.arrayBuffer());
    const hotspots: BackupHotspot[] = [];
    for (const h of s.hotspots) {
      const { photo, ...rest } = h;
      let photoRef: string | undefined;
      if (photo) {
        photoRef = `hotspotPhotos/${h.id}.jpg`;
        files[photoRef] = new Uint8Array(await photo.arrayBuffer());
      }
      hotspots.push({ ...rest, photoRef });
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
    });
  }

  if (project.mapImage) files["map.jpg"] = new Uint8Array(await project.mapImage.arrayBuffer());

  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    title: project.title,
    scenes: backupScenes,
    hasMapImage: !!project.mapImage,
  };
  files["backup.json"] = new TextEncoder().encode(JSON.stringify(manifest));

  const zipped = zipSync(files, { level: 6 });
  return { blob: new Blob([zipped], { type: "application/zip" }), filename: `${slugify(project.title)}-backup.zip` };
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

  if (manifest.hasMapImage) {
    const mapBytes = files["map.jpg"];
    if (mapBytes) await db.projects.update(project.id, { mapImage: new Blob([new Uint8Array(mapBytes)], { type: "image/jpeg" }) });
  }

  for (const s of manifest.scenes) {
    const imgBytes = files[`images/${s.id}.jpg`];
    const thumbBytes = files[`thumbs/${s.id}.jpg`];
    if (!imgBytes || !thumbBytes) continue;
    const hotspots: Hotspot[] = s.hotspots.map((h) => {
      const { photoRef, ...rest } = h;
      const photoBytes = photoRef ? files[photoRef] : undefined;
      return {
        ...rest,
        id: uid(),
        targetId: h.targetId ? idMap.get(h.targetId) ?? null : null,
        photo: photoBytes ? new Blob([new Uint8Array(photoBytes)], { type: "image/jpeg" }) : undefined,
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
    });
  }
  return project;
}
