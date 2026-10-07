// После сборки 3D-просмотрщика (postbuild:viewer3d, см. package.json) кладёт
// его код строкой в src/export/viewer3dAsset.generated.ts. Зачем строкой, а не
// файлом: приложение может быть открыто прямо с диска (file://), где нельзя
// ни fetch(), ни динамический import — а <script>, созданный из строки, работает.
import { readFileSync, writeFileSync } from "node:fs";

const js = readFileSync("build-viewer3d/viewer3d.js", "utf8");
writeFileSync(
  "src/export/viewer3dAsset.generated.ts",
  `// АВТОГЕНЕРИРУЕТСЯ — scripts/gen-viewer3d-asset.mjs, шаг postbuild:viewer3d. Не редактировать руками.
export const VIEWER3D_JS: string = ${JSON.stringify(js)};
`,
);
console.log(`viewer3dAsset.generated.ts: ${(js.length / 1024).toFixed(0)} КБ`);
