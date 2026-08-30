// Chrome блокирует <script type="module"> под file:// как cross-origin —
// та же причина, по которой экспортированные туры изначально не открывались
// двойным кликом с диска (см. src/export/bundle.ts). Приложение собирается
// в один-единственный JS-чанк без code-splitting (проверено — ни одного
// оставшегося import/export в собранном файле), так что module-семантика
// ему не нужна: просто убираем type="module"/crossorigin из тегов, чтобы
// dist/index.html можно было открыть прямо с диска, без веб-сервера.
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/index.html";
let html = readFileSync(path, "utf8");
// type="module" даёт скрипту автоматический defer (ждёт разбора HTML,
// #root в разметке уже есть) — просто убрав type, получили бы обычный
// синхронный <script> в <head>, который выполнился бы ДО появления #root
// в DOM. defer сохраняет то же поведение при обычном классическом скрипте.
html = html.replace(/ type="module" crossorigin/, " defer").replace(/ crossorigin(?= href)/, "");
writeFileSync(path, html);
console.log("dist/index.html: убран type=\"module\"/crossorigin — открывается прямо с диска (file://).");
