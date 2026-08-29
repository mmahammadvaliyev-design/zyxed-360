// Сборка публикуемого тура: берём уже собранный автономный плеер (public/player,
// npm run build:player), докладываем данные тура и картинки — и всё это в один ZIP.
// Результат можно залить на любой статический хостинг: GitHub Pages, Netlify, Vercel.
import { zipSync } from "fflate";
import { db } from "../db";
import type { SceneMeta, TourManifest } from "../engine/types";

async function fetchBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось загрузить ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// Разбираем index.html плеера, чтобы найти его файлы — так не важно, как Vite
// назвал хэшированные assets/*.js при сборке.
async function collectPlayerFiles(): Promise<Record<string, Uint8Array>> {
  const base = "./player/";
  const htmlRes = await fetch(base + "index.html");
  if (!htmlRes.ok) {
    throw new Error("Плеер тура не собран. Выполните `npm run build:player` и повторите экспорт.");
  }
  const html = await htmlRes.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const refs = new Set<string>();
  doc.querySelectorAll("script[src], link[href]").forEach((el) => {
    const src = el.getAttribute("src") || el.getAttribute("href");
    if (src && !/^(https?:)?\/\//.test(src)) refs.add(src.replace(/^\.\//, ""));
  });
  const files: Record<string, Uint8Array> = { "index.html": new TextEncoder().encode(html) };
  for (const ref of refs) files[ref] = await fetchBinary(base + ref);
  return files;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tour"
  );
}

export async function exportProjectZip(projectId: string): Promise<{ blob: Blob; filename: string }> {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error("Проект не найден");
  const scenes = await db.scenes.where("projectId").equals(projectId).sortBy("order");
  if (!scenes.length) throw new Error("В туре нет ни одной панорамы — экспортировать нечего.");

  const manifest: TourManifest = {
    title: project.title,
    scenes: scenes.map(
      (s): SceneMeta => ({
        id: s.id,
        title: s.title,
        width: s.width,
        height: s.height,
        order: s.order,
        yaw: s.yaw,
        pitch: s.pitch,
        fov: s.fov,
        hotspots: s.hotspots,
      }),
    ),
  };

  const files = await collectPlayerFiles();
  files["data.json"] = new TextEncoder().encode(JSON.stringify(manifest));
  for (const s of scenes) {
    files[`images/${s.id}.jpg`] = new Uint8Array(await s.image.arrayBuffer());
  }

  const zipped = zipSync(files, { level: 6 });
  return { blob: new Blob([zipped], { type: "application/zip" }), filename: `${slugify(project.title)}.zip` };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
