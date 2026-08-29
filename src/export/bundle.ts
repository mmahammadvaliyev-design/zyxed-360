// Сборка публикуемого тура: берём уже собранный автономный плеер (public/player,
// npm run build:player), встраиваем данные тура и картинки прямо в его index.html —
// и всё это в один ZIP. Результат можно залить на любой статический хостинг
// (GitHub Pages, Netlify, Vercel), а можно и просто открыть index.html двойным
// кликом с диска: данные не запрашиваются отдельным fetch(), которые браузеры
// блокируют для локальных файлов по file://, а сам скрипт мы кладём как обычный
// classic <script> — Chrome блокирует по file:// и <script type="module">, даже
// если у него нет ни одного import/export (собранный Vite-бандл плеера — как раз
// такой самодостаточный файл, так что classic-тег для него ничем не отличается).
import { zipSync } from "fflate";
import { db, type Hotspot } from "../db";
import type { SceneMeta, TourManifest } from "../engine/types";
import { getFeatureSnapshot, isFeatureEnabled } from "../features";
import { getBranding } from "../branding";

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
async function collectPlayerAssets(): Promise<{ js: string[]; css: string[]; assets: Record<string, Uint8Array> }> {
  const base = "./player/";
  const htmlRes = await fetch(base + "index.html");
  if (!htmlRes.ok) {
    throw new Error("Плеер тура не собран. Выполните `npm run build:player` и повторите экспорт.");
  }
  const html = await htmlRes.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const js: string[] = [];
  const css: string[] = [];
  doc.querySelectorAll("script[src]").forEach((el) => {
    const src = el.getAttribute("src");
    if (src && !/^(https?:)?\/\//.test(src)) js.push(src.replace(/^\.\//, ""));
  });
  doc.querySelectorAll("link[href]").forEach((el) => {
    const href = el.getAttribute("href");
    if (href && !/^(https?:)?\/\//.test(href)) css.push(href.replace(/^\.\//, ""));
  });
  const assets: Record<string, Uint8Array> = {};
  for (const ref of [...js, ...css]) assets[ref] = await fetchBinary(base + ref);
  return { js, css, assets };
}

function buildIndexHtml(opts: { js: string[]; css: string[]; dataScript: string }): string {
  const cssLinks = opts.css.map((href) => `    <link rel="stylesheet" href="./${href}" />`).join("\n");
  // Classic-скрипт (без type="module") в head выполнился бы до появления
  // #app в body — ставим в конец body, как исходник player/index.html.
  const jsScripts = opts.js.map((src) => `    <script src="./${src}"></script>`).join("\n");
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
    <meta name="theme-color" content="#05060c" />
    <title>360°-тур</title>
${cssLinks}
    ${opts.dataScript}
  </head>
  <body>
    <div id="app"></div>
${jsScripts}
  </body>
</html>
`;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tour"
  );
}

// Хотспот в БД хранит фото заметки как Blob (photo); в манифесте вместо него
// нужен data: URI (photoUrl, как и с картинками сцен) — Blob не переживёт
// JSON.stringify.
async function exportHotspots(hotspots: Hotspot[]): Promise<Hotspot[]> {
  return Promise.all(
    hotspots.map(
      async (h): Promise<Hotspot> => ({
        id: h.id,
        yaw: h.yaw,
        pitch: h.pitch,
        label: h.label,
        targetId: h.targetId,
        note: h.note,
        labelEn: h.labelEn,
        noteEn: h.noteEn,
        photoUrl: h.photo ? await blobToDataUrl(h.photo) : undefined,
      }),
    ),
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
    scenes: await Promise.all(
      scenes.map(
        async (s): Promise<SceneMeta> => ({
          id: s.id,
          title: s.title,
          titleEn: s.titleEn,
          width: s.width,
          height: s.height,
          order: s.order,
          yaw: s.yaw,
          pitch: s.pitch,
          fov: s.fov,
          hotspots: await exportHotspots(s.hotspots),
        }),
      ),
    ),
    images,
    features: getFeatureSnapshot(),
    branding: isFeatureEnabled("branding") ? getBranding() : undefined,
  };

  const { js, css, assets } = await collectPlayerAssets();
  // Заголовки/подписи переходов — пользовательский текст; экранируем "<", чтобы
  // случайное "</script>" в подписи не сломало встроенный JSON и не превратилось
  // в разметку/скрипт на странице тура.
  const dataScript = `<script id="tour-data" type="application/json">${JSON.stringify(manifest).replace(/</g, "\\u003c")}</script>`;
  const indexHtml = buildIndexHtml({ js, css, dataScript });

  const files: Record<string, Uint8Array> = { "index.html": new TextEncoder().encode(indexHtml), ...assets };

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
