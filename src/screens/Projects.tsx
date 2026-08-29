import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import { createProject, db, deleteProject, duplicateProject, uid, type Project, type Scene } from "../db";
import { DEFAULT_FOV, rad } from "../engine/pano";
import { DEMO_PRESETS, makeDemoPanorama, prepareImage } from "../imageImport";

export default function Projects() {
  const nav = useNavigate();
  const projects = useLiveQuery(() => db.projects.orderBy("updatedAt").reverse().toArray(), []);
  const firstScenes = useLiveQuery(() => db.scenes.toArray(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

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
    const p = await createProject("Новый тур");
    nav(`/p/${p.id}`);
  }

  async function addDemoProject() {
    setBusy("Рисую демо-тур…");
    try {
      const project = await createProject("Демо-тур");
      const ids = DEMO_PRESETS.map(() => uid());
      for (let i = 0; i < DEMO_PRESETS.length; i++) {
        const preset = DEMO_PRESETS[i];
        const blob = await makeDemoPanorama(preset);
        const prep = await prepareImage(blob);
        const next = DEMO_PRESETS[(i + 1) % DEMO_PRESETS.length];
        const prev = DEMO_PRESETS[(i - 1 + DEMO_PRESETS.length) % DEMO_PRESETS.length];
        await db.scenes.put({
          id: ids[i],
          projectId: project.id,
          title: preset.title,
          image: prep.image,
          thumb: prep.thumb,
          width: prep.width,
          height: prep.height,
          order: i,
          yaw: 0,
          pitch: 0,
          fov: DEFAULT_FOV,
          hotspots: [
            { id: uid(), yaw: rad(90), pitch: rad(-8), label: next.title, targetId: ids[(i + 1) % ids.length] },
            { id: uid(), yaw: rad(-90), pitch: rad(-8), label: prev.title, targetId: ids[(i - 1 + ids.length) % ids.length] },
          ],
        });
      }
      nav(`/p/${project.id}`);
    } finally {
      setBusy(null);
    }
  }

  async function rename(p: Project, title: string) {
    await db.projects.update(p.id, { title, updatedAt: new Date().toISOString() });
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

  return (
    <div>
      <div className="brand">
        <div className="brand-mark">Z</div>
        <div>
          <h1 style={{ margin: 0 }}>Zyxed 360</h1>
          <div className="muted">Офлайн-конструктор 360°-туров</div>
        </div>
      </div>

      <button className="primary" style={{ width: "100%" }} disabled={!!busy} onClick={newProject}>
        + Новый тур
      </button>
      <button className="ghost" style={{ width: "100%", marginTop: 8 }} disabled={!!busy} onClick={addDemoProject}>
        Показать демо-тур
      </button>

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
                <input
                  type="text"
                  value={p.title}
                  onChange={(e) => rename(p, e.target.value)}
                  aria-label="Название тура"
                  style={{ fontWeight: 700, padding: "6px 8px" }}
                />
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
          Туров пока нет. Создайте новый — или нажмите «Показать демо-тур»,
          чтобы сразу увидеть, как это работает.
        </div>
      )}
    </div>
  );
}
