// Сборка публикуемого тура: берём уже собранный автономный плеер (public/player,
// npm run build:player), встраиваем данные тура и картинки прямо в его index.html —
// и всё это в один ZIP. Результат можно залить на любой статический хостинг
// (GitHub Pages, Netlify, Vercel), а можно и просто открыть index.html двойным
// кликом с диска: данные не запрашиваются отдельным fetch(), которые браузеры
// блокируют для локальных файлов по file://.
import { zipSync } from "fflate";
import { db } from "../db";
import type { SceneMeta, TourManifest } from "../engine/types";

async function fetchBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось загрузить ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать изображение"));
    reader.readAsDataURL(blob);
  });
}

// Разбираем index.html плеера, чтобы найти его js/css файлы — так не важно, как Vite
// назвал хэшированные assets/*.js при сборке.
async function collectPlayerAssets(): Promise<{ html: string; assets: Record<string, Uint8Array> }> {
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
  const assets: Record<string, Uint8Array> = {};
  for (const ref of refs) assets[ref] = await fetchBinary(base + ref);
  return { html, assets };
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

  const images: Record<string, string> = {};
  for (const s of scenes) images[s.id] = await blobToDataUrl(s.image);

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
    images,
  };

  const { html, assets } = await collectPlayerAssets();
  // Заголовки/подписи переходов — пользовательский текст; экранируем "<", чтобы
  // случайное "</script>" в подписи не сломало встроенный JSON и не превратилось
  // в разметку/скрипт на странице тура.
  const dataScript = `<script id="tour-data" type="application/json">${JSON.stringify(manifest).replace(/</g, "\\u003c")}</script>`;
  const withData = html.replace("</head>", `${dataScript}</head>`);

  const files: Record<string, Uint8Array> = { "index.html": new TextEncoder().encode(withData), ...assets };

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
