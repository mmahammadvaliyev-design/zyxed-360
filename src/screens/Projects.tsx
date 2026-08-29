import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import { createProject, db, deleteProject, duplicateProject, uniqueProjectTitle, type Project, type Scene } from "../db";
import { importProjectBackup } from "../export/backup";
import { useFeature } from "../features";

// Название тура — обязательное и уникальное (см. uniqueProjectTitle в db.ts).
// Локальный черновик, чтобы не писать в БД на каждое нажатие клавиши и не
// откатывать курсор пользователю; проверка — по потере фокуса.
function ProjectTitleInput({ project, onError }: { project: Project; onError: (msg: string) => void }) {
  const [draft, setDraft] = useState(project.title);
  useEffect(() => setDraft(project.title), [project.id, project.title]);

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(project.title);
      onError("Название тура не может быть пустым.");
      return;
    }
    if (trimmed === project.title) return;
    const unique = await uniqueProjectTitle(trimmed, project.id);
    if (unique !== trimmed) {
      setDraft(project.title);
      onError(`Тур с названием «${trimmed}» уже есть — выберите другое название.`);
      return;
    }
    await db.projects.update(project.id, { title: trimmed, updatedAt: new Date().toISOString() });
  }

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      aria-label="Название тура"
      style={{ fontWeight: 700, padding: "6px 8px" }}
    />
  );
}

export default function Projects() {
  const nav = useNavigate();
  const projects = useLiveQuery(() => db.projects.orderBy("updatedAt").reverse().toArray(), []);
  const firstScenes = useLiveQuery(() => db.scenes.toArray(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const backupRef = useRef<HTMLInputElement>(null);
  const projectBackup = useFeature("projectBackup");

  // Превью первой панорамы каждого проекта (по минимальному order).
  useEffect(() => {
    if (!firstScenes) return;
    const byProject = new Map<string, Scene>();
    for (const s of firstScenes) {
      const cur = byProject.get(s.projectId);
      if (!cur || s.order < cur.order) byProject.set(s.projectId, s);
    }
    const map: Record<string, string> = {};
    byProject.forEach((s, pid) => { map[pid] = URL.createObjectURL(s.thumb); });
    setThumbs(map);
    return () => { Object.values(map).forEach((u) => URL.revokeObjectURL(u)); };
  }, [firstScenes]);

  const countByProject = new Map<string, number>();
  for (const s of firstScenes ?? []) countByProject.set(s.projectId, (countByProject.get(s.projectId) ?? 0) + 1);

  async function newProject() {
    const title = await uniqueProjectTitle("Новый тур");
    const p = await createProject(title);
    nav(`/p/${p.id}`);
  }

  async function remove(p: Project) {
    if (!window.confirm(`Удалить тур «${p.title}» со всеми панорамами? Это необратимо.`)) return;
    await deleteProject(p.id);
  }

  async function duplicate(p: Project) {
    setBusy("Дублирую тур…");
    try {
      await duplicateProject(p.id);
    } finally {
      setBusy(null);
    }
  }

  // Функция «Резервная копия / перенос проекта»: восстанавливаем полный
  // редактируемый тур из файла, собранного кнопкой «Копия» в редакторе —
  // всегда как новый проект, чтобы не перезаписать что-то существующее.
  async function importBackup(file: File | undefined) {
    if (!file) return;
    setNote(null);
    setBusy("Импортирую копию…");
    try {
      const project = await importProjectBackup(file);
      nav(`/p/${project.id}`);
    } catch (e) {
      setNote(`Не удалось импортировать копию: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      if (backupRef.current) backupRef.current.value = "";
    }
  }

  return (
    <div>
      <div className="brand">
        <div className="row" style={{ gap: 10 }}>
          <div className="brand-mark">Z</div>
          <div>
            <h1 style={{ margin: 0 }}>Zyxed 360</h1>
            <div className="muted">Офлайн-конструктор 360°-туров</div>
          </div>
        </div>
        <button className="ghost small" onClick={() => nav("/settings")} title="Настройки" aria-label="Настройки">⚙</button>
      </div>

      <button className="primary" style={{ width: "100%" }} disabled={!!busy} onClick={newProject}>
        + Новый тур
      </button>
      {projectBackup && (
        <>
          <button className="ghost" style={{ width: "100%", marginTop: 8 }} disabled={!!busy} onClick={() => backupRef.current?.click()}>
            ⬆ Импортировать копию
          </button>
          <input
            ref={backupRef}
            type="file"
            accept=".zip,application/zip"
            style={{ display: "none" }}
            onChange={(e) => importBackup(e.target.files?.[0])}
          />
        </>
      )}

      {note && (
        <div className="card banner" style={{ marginTop: 11 }}>
          <div className="row spread" style={{ gap: 8, alignItems: "flex-start" }}>
            <div style={{ lineHeight: 1.5 }}>{note}</div>
            <button className="ghost small" onClick={() => setNote(null)} aria-label="Скрыть">✕</button>
          </div>
        </div>
      )}
      {busy && <div className="card center muted" style={{ marginTop: 11 }}>{busy}</div>}

      {projects && projects.length > 0 && (
        <>
          <h2>Мои туры · {projects.length}</h2>
          {projects.map((p) => (
            <div className="card proj-item" key={p.id}>
              <button className="proj-thumb" onClick={() => nav(`/p/${p.id}`)} title="Открыть">
                {thumbs[p.id] ? <img src={thumbs[p.id]} alt="" /> : "🌐"}
              </button>
              <div className="grow">
                <ProjectTitleInput project={p} onError={setNote} />
                <div className="muted" style={{ marginTop: 6 }}>{countByProject.get(p.id) ?? 0} панорам</div>
                <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                  <button className="ghost small grow" onClick={() => nav(`/p/${p.id}`)}>Открыть</button>
                  <button className="ghost small" onClick={() => duplicate(p)} title="Дублировать">⧉</button>
                  <button className="ghost small" onClick={() => remove(p)} aria-label="Удалить">🗑</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {projects && projects.length === 0 && !busy && (
        <div className="empty">
          Туров пока нет. Нажмите «+ Новый тур», чтобы начать.
        </div>
      )}
    </div>
  );
}
