import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams } from "react-router-dom";
import { db, uid, type Hotspot, type Scene } from "../db";
import { DEFAULT_FOV, rad } from "../engine/pano";
import { prepareImage, ratioHint } from "../imageImport";
import { downloadBlob, exportProjectZip } from "../export/bundle";
import PanoViewer from "../components/PanoViewer";
import { useEffect } from "react";

function titleFromFile(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (!base) return "Панорама";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function sizeMb(scenes: Scene[]): string {
  const bytes = scenes.reduce((s, x) => s + (x.image.size ?? 0) + (x.thumb.size ?? 0), 0);
  return (bytes / 1024 / 1024).toFixed(1);
}

export default function Editor() {
  const { id } = useParams<{ id: string }>();
  const projectId = id!;
  const nav = useNavigate();

  const project = useLiveQuery(() => db.projects.get(projectId), [projectId]);
  const scenes = useLiveQuery(() => db.scenes.where("projectId").equals(projectId).sortBy("order"), [projectId]);
  const list = useMemo(() => scenes ?? [], [scenes]);

  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const map: Record<string, string> = {};
    for (const s of list) map[s.id] = URL.createObjectURL(s.thumb);
    setThumbs(map);
    return () => { Object.values(map).forEach((u) => URL.revokeObjectURL(u)); };
  }, [list]);

  async function touch() {
    await db.projects.update(projectId, { updatedAt: new Date().toISOString() });
  }

  async function nextOrder(): Promise<number> {
    const last = await db.scenes.where("projectId").equals(projectId).sortBy("order");
    return last.length ? last[last.length - 1].order + 1 : 0;
  }

  async function addFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setNote(null);
    let order = await nextOrder();
    let warned: string | null = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setBusy(`Обрабатываю ${i + 1} из ${files.length}…`);
      try {
        const prep = await prepareImage(file);
        warned = warned ?? ratioHint(prep.width, prep.height);
        await db.scenes.put({
          id: uid(),
          projectId,
          title: titleFromFile(file.name),
          image: prep.image,
          thumb: prep.thumb,
          width: prep.width,
          height: prep.height,
          order: order++,
          yaw: 0,
          pitch: 0,
          fov: DEFAULT_FOV,
          hotspots: [],
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        warned =
          err.name === "QuotaExceededError"
            ? "В браузере закончилось место — удалите часть панорам или старые данные."
            : `Не получилось добавить «${file.name}»: ${err.message ?? "неизвестная ошибка"}`;
      }
    }
    await touch();
    setBusy(null);
    setNote(warned);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function linkInCircle() {
    if (list.length < 2) return;
    setBusy("Расставляю переходы…");
    for (let i = 0; i < list.length; i++) {
      const scene = list[i];
      const next = list[(i + 1) % list.length];
      const prev = list[(i - 1 + list.length) % list.length];
      const wanted: Hotspot[] = [
        { id: uid(), yaw: rad(90), pitch: rad(-8), label: next.title, targetId: next.id },
        { id: uid(), yaw: rad(-90), pitch: rad(-8), label: prev.title, targetId: prev.id },
      ];
      const add = wanted.filter((w) => !scene.hotspots.some((h) => h.targetId === w.targetId));
      if (add.length) await db.scenes.update(scene.id, { hotspots: [...scene.hotspots, ...add] });
    }
    await touch();
    setBusy(null);
    setNote("Переходы расставлены: вправо — следующая панорама, влево — предыдущая. Место можно поправить в туре (карандаш).");
  }

  async function rename(scene: Scene, title: string) {
    await db.scenes.update(scene.id, { title });
    await touch();
  }

  async function move(index: number, dir: -1 | 1) {
    const a = list[index];
    const b = list[index + dir];
    if (!a || !b) return;
    await db.scenes.update(a.id, { order: b.order });
    await db.scenes.update(b.id, { order: a.order });
    await touch();
  }

  async function remove(scene: Scene) {
    if (!window.confirm(`Удалить панораму «${scene.title}»?`)) return;
    await db.scenes.delete(scene.id);
    for (const s of list) {
      if (s.id === scene.id) continue;
      if (!s.hotspots.some((h) => h.targetId === scene.id)) continue;
      await db.scenes.update(s.id, { hotspots: s.hotspots.map((h) => (h.targetId === scene.id ? { ...h, targetId: null } : h)) });
    }
    await touch();
  }

  async function saveScene(s: Scene) {
    await db.scenes.put(s);
    await touch();
  }

  async function doExport() {
    setNote(null);
    setBusy("Собираю файлы тура…");
    try {
      const { blob, filename } = await exportProjectZip(projectId);
      downloadBlob(blob, filename);
      setNote(`Готово: ${filename} скачан. Загрузите содержимое архива на любой статический хостинг (GitHub Pages, Netlify, Vercel) — и тур будет доступен по ссылке.`);
    } catch (e) {
      setNote(`Не удалось собрать экспорт: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const openScene = openId ? list.find((s) => s.id === openId) : null;

  if (project === undefined) return null;
  if (project === null) {
    return (
      <div className="empty">
        Тур не найден.
        <div style={{ marginTop: 14 }}>
          <button className="ghost" onClick={() => nav("/")}>← К списку туров</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button className="back-link" onClick={() => nav("/")}>← Все туры</button>
      <input
        type="text"
        value={project.title}
        onChange={(e) => db.projects.update(projectId, { title: e.target.value, updatedAt: new Date().toISOString() })}
        style={{ fontWeight: 800, fontSize: 22, padding: "8px 10px", marginBottom: 14 }}
        aria-label="Название тура"
      />

      {note && (
        <div className="card banner">
          <div className="row spread" style={{ gap: 8, alignItems: "flex-start" }}>
            <div style={{ lineHeight: 1.5 }}>{note}</div>
            <button className="ghost small" onClick={() => setNote(null)} aria-label="Скрыть">✕</button>
          </div>
        </div>
      )}

      <div className="card">
        <button className="primary" style={{ width: "100%" }} disabled={!!busy} onClick={() => fileRef.current?.click()}>
          📷 Добавить панорамы
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
        <p className="muted" style={{ marginBottom: 0, marginTop: 10, lineHeight: 1.5 }}>
          Подойдёт любой сферический снимок 2:1 — из режима «Панорама 360» на телефоне,
          с экшн-камеры или из Google Street View.
        </p>
      </div>

      {busy && <div className="card center muted">{busy}</div>}

      {list.length > 0 && (
        <>
          <div className="row wrap" style={{ gap: 8, marginBottom: 11 }}>
            <button className="primary grow" onClick={() => setOpenId(list[0].id)}>▶ Открыть тур</button>
            {list.length > 1 && <button className="ghost" disabled={!!busy} onClick={linkInCircle}>Связать по кругу</button>}
            <button className="ghost" disabled={!!busy} onClick={doExport}>⬇ Экспорт</button>
          </div>

          <h2>Панорамы · {list.length} шт · {sizeMb(list)} МБ</h2>
          {list.map((s, i) => (
            <div className="card pano-item" key={s.id}>
              <button className="pano-thumb" onClick={() => setOpenId(s.id)} title="Открыть">
                {thumbs[s.id] ? <img src={thumbs[s.id]} alt="" /> : <span className="muted">…</span>}
              </button>
              <div className="grow">
                <input type="text" value={s.title} onChange={(e) => rename(s, e.target.value)} aria-label="Название панорамы" />
                <div className="muted" style={{ marginTop: 6 }}>{s.width}×{s.height} · переходов: {s.hotspots.length}</div>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <button className="ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Выше">↑</button>
                  <button className="ghost small" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">↓</button>
                  <button className="ghost small grow" onClick={() => setOpenId(s.id)}>Открыть</button>
                  <button className="ghost small" onClick={() => remove(s)} aria-label="Удалить">🗑</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {list.length === 0 && !busy && (
        <div className="empty">Добавьте первую панораму, чтобы начать собирать тур.</div>
      )}

      {openScene && (
        <PanoViewer scenes={list} startId={openScene.id} editable onClose={() => setOpenId(null)} onChange={saveScene} />
      )}
    </div>
  );
}
