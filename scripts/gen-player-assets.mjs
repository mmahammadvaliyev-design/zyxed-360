// Запускается сразу после сборки плеера (postbuild:player, см. package.json).
// «Экспорт» в редакторе тура (src/export/bundle.ts) раньше подтягивал уже
// собранный плеер (public/player/*) через fetch() в момент экспорта — это
// ломалось под file:// (офлайн-сборка самого приложения, см. commit
// про scripts/fix-offline-html.mjs): fetch() локальных файлов браузер
// блокирует, точно так же, как раньше не открывались опубликованные туры.
// Вместо runtime fetch — встраиваем собранный плеер статическими строками
// прямо в бандл приложения на этапе СБОРКИ; экспорту дальше не нужна сеть.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const playerDir = "public/player";
const html = readFileSync(join(playerDir, "index.html"), "utf8");

const refs = [...html.matchAll(/<(?:script[^>]+src|link[^>]+href)="([^"]+)"/g)].map((m) => m[1].replace(/^\.\//, ""));

const assets = {};
for (const ref of refs) {
  assets[ref] = readFileSync(join(playerDir, ref), "utf8");
}

const out = `// АВТОГЕНЕРИРУЕТСЯ — scripts/gen-player-assets.mjs, шаг postbuild:player. Не редактировать руками.
export const PLAYER_HTML: string = ${JSON.stringify(html)};
export const PLAYER_ASSETS: Record<string, string> = ${JSON.stringify(assets, null, 2)};
`;

writeFileSync("src/export/playerAssets.generated.ts", out);
console.log(`playerAssets.generated.ts: встроено ${refs.length} файл(ов) плеера (${refs.join(", ")}).`);
