// «Документы» — читаемый для человека слой в папке тура.
//
// Служебные папки копии (lineFiles/, hotspotFiles/) названы по id — по ним
// программа восстанавливает тур, но человеку в них ничего не найти. Поэтому
// рядом кладём ещё один набор, разложенный по понятным названиям:
//
//   Документы/Линии/<название трубы>/<файл как был назван>
//   Документы/Линии/<название трубы>/Описание.txt   (текст и ссылки)
//   Документы/Заметки/<панорама> — <заметка>/…
//
// Нужный чертёж можно взять прямо из папки, не открывая тур. Это производный
// слой: восстановление тура его не использует, поэтому он ничем не рискует.
import type { NotePdf } from "../engine/types";
import { db } from "../db";

export interface DocEntry {
  path: string;
  blob?: Blob;
  text?: string;
}

export const DOCS_ROOT = "Документы";

// Имя файла/папки, безопасное для Windows/macOS: без \ / : * ? " < > |,
// без точек и пробелов на конце, не длиннее 80 знаков.
export function safeDocName(name: string, fallback: string): string {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "")
    .replace(/^\.+/, "");
  return s || fallback;
}

// Уникальное имя среди уже занятых (без учёта регистра — Windows/macOS не
// различают): «файл.pdf», «файл (2).pdf», «файл (3).pdf»…
function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

interface DocSource {
  title: string; // название папки
  note?: string;
  photo?: Blob;
  pdfs?: NotePdf[];
}

// Содержимое одной папки: файлы, фото и «Описание.txt» (текст + ссылки).
function entriesFor(dir: string, src: DocSource): DocEntry[] {
  const out: DocEntry[] = [];
  const taken = new Set<string>(["описание.txt"]);
  const links: string[] = [];
  for (const p of src.pdfs ?? []) {
    if (p.href) {
      links.push(`${p.name}: ${p.href}`);
      continue;
    }
    if (!p.data) continue;
    out.push({ path: `${dir}/${uniqueName(safeDocName(p.name, "файл"), taken)}`, blob: p.data });
  }
  if (src.photo) out.push({ path: `${dir}/${uniqueName("Фото.jpg", taken)}`, blob: src.photo });
  const parts: string[] = [src.title];
  if (src.note?.trim()) parts.push("", src.note.trim());
  if (links.length) parts.push("", "Ссылки:", ...links);
  if (src.note?.trim() || links.length) out.push({ path: `${dir}/Описание.txt`, text: parts.join("\r\n") + "\r\n" });
  return out;
}

const hasContent = (s: Omit<DocSource, "title">): boolean =>
  !!(s.note?.trim() || s.photo || s.pdfs?.some((p) => p.href || p.data));

export async function collectDocumentEntries(projectId: string): Promise<DocEntry[]> {
  const project = await db.projects.get(projectId);
  if (!project) return [];
  const scenes = await db.scenes.where("projectId").equals(projectId).sortBy("order");
  const entries: DocEntry[] = [];

  const lineDirs = new Set<string>();
  for (const l of project.lines ?? []) {
    if (!hasContent(l)) continue;
    const name = uniqueName(safeDocName(l.name, "Линия"), lineDirs);
    entries.push(...entriesFor(`${DOCS_ROOT}/Линии/${name}`, { title: l.name, note: l.note, photo: l.photo, pdfs: l.pdfs }));
  }

  const noteDirs = new Set<string>();
  for (const s of scenes) {
    for (const h of s.hotspots) {
      if (h.targetId || !hasContent(h)) continue; // только заметки (не переходы)
      const label = h.label?.trim();
      const name = uniqueName(safeDocName(label ? `${s.title} — ${label}` : s.title, "Заметка"), noteDirs);
      entries.push(...entriesFor(`${DOCS_ROOT}/Заметки/${name}`, { title: label ? `${s.title} — ${label}` : s.title, note: h.note, photo: h.photo, pdfs: h.pdfs }));
    }
  }
  return entries;
}
