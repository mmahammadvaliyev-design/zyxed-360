import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams } from "react-router-dom";
import { db, deleteProject, uid, uniqueProjectTitle, type Hotspot, type Scene } from "../db";
import { DEFAULT_FOV, rad } from "../engine/pano";
import { prepareImage, ratioHint } from "../imageImport";
import { downloadBlob, exportProjectZip, slugify } from "../export/bundle";
import { exportProjectBackup } from "../export/backup";
import { renderQrToCanvas } from "../qr";
import PanoViewer from "../components/PanoViewer";
import MapEditor from "../components/MapEditor";
import { useEffect } from "react";
import { useFeature } from "../features";
import { tNow, useT } from "../i18n";

function titleFromFile(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (!base) return tNow("Панорама", "Panorama");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function sizeMb(scenes: Scene[]): string {
  const bytes = scenes.reduce((s, x) => s + (x.image.size ?? 0) + (x.thumb.size ?? 0), 0);
  return (bytes / 1024 / 1024).toFixed(1);
}

// Функция «Сжатие панорам при импорте».
type CompressionPresetId = "original" | "standard" | "compact";
const COMPRESSION_PRESETS: { id: CompressionPresetId; labelRu: string; labelEn: string }[] = [
  { id: "original", labelRu: "Оригинал — без доп. сжатия", labelEn: "Original — no extra compression" },
  { id: "standard", labelRu: "Стандарт — до 2048px, качество 85%", labelEn: "Standard — up to 2048px, 85% quality" },
  { id: "compact", labelRu: "Компактно — до 1440px, качество 72%", labelEn: "Compact — up to 1440px, 72% quality" },
];
function compressionOpts(id: CompressionPresetId): { maxWidth?: number; quality?: number } {
  if (id === "standard") return { maxWidth: 2048, quality: 0.85 };
  if (id === "compact") return { maxWidth: 1440, quality: 0.72 };
  return {};
}

export default function Editor() {
  const { id } = useParams<{ id: string }>();
  const projectId = id!;
  const nav = useNavigate();
  const t = useT();

  const project = useLiveQuery(() => db.projects.get(projectId), [projectId]);
  const scenes = useLiveQuery(() => db.scenes.where("projectId").equals(projectId).sortBy("order"), [projectId]);
  const list = useMemo(() => scenes ?? [], [scenes]);

  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const circleLink = useFeature("circleLink");
  const linearChain = useFeature("linearChain");
  const projectBackup = useFeature("projectBackup");
  const qrCode = useFeature("qrCode");
  const compression = useFeature("compression");
  const dragReorder = useFeature("dragReorder");
  const i18n = useFeature("i18n");
  const mapFeature = useFeature("map");
  const [qrUrl, setQrUrl] = useState("");
  const [qrError, setQrError] = useState<string | null>(null);
  const [hasQr, setHasQr] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const [compressionPreset, setCompressionPreset] = useState<CompressionPresetId>("original");
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragInfoRef = useRef<{ id: string; pointerId: number } | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  // dragEnd читает итоговый порядок напрямую из dragOrder — а это значение
  // из замыкания РЕНДЕРА, в котором был создан текущий onPointerUp-обработчик.
  // При очень быстром жесте (down→move→up быстрее, чем React успевает
  // перерендерить и подставить свежий обработчик) сработал бы устаревший
  // dragEnd, всё ещё видящий dragOrder === null от самого первого рендера —
  // перетаскивание тихо ничего бы не сохранило. Дублируем в реф, обновляем
  // синхронно вместе с setDragOrder — dragEnd берёт значение оттуда.
  const dragOrderRef = useRef<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const map: Record<string, string> = {};
    for (const s of list) map[s.id] = URL.createObjectURL(s.thumb);
    setThumbs(map);
    return () => { Object.values(map).forEach((u) => URL.revokeObjectURL(u)); };
  }, [list]);

  // Название тура — обязательное и уникальное. Черновик отдельно от БД,
  // чтобы не откатывать курсор на каждое нажатие; проверка по потере фокуса.
  const [titleDraft, setTitleDraft] = useState("");
  useEffect(() => { if (project) setTitleDraft(project.title); }, [project?.id]);

  async function commitTitle() {
    if (!project) return;
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleDraft(project.title);
      setNote(t("Название тура не может быть пустым.", "Tour name can't be empty."));
      return;
    }
    if (trimmed === project.title) return;
    const unique = await uniqueProjectTitle(trimmed, projectId);
    if (unique !== trimmed) {
      setTitleDraft(project.title);
      setNote(
        t(
          `Тур с названием «${trimmed}» уже есть — выберите другое название.`,
          `A tour named "${trimmed}" already exists — choose another name.`,
        ),
      );
      return;
    }
    await db.projects.update(projectId, { title: trimmed, updatedAt: new Date().toISOString() });
  }

  // Функция против "пустых болванок": если тур так и остался без единой
  // панорамы, при выходе спрашиваем — удалить черновик или оставить.
  async function handleBack() {
    if (list.length === 0) {
      if (
        window.confirm(
          t(
            `Тур «${project?.title ?? ""}» пока пуст — удалить его, чтобы не копились пустые заготовки?`,
            `The tour "${project?.title ?? ""}" is still empty — delete it so empty drafts don't pile up?`,
          ),
        )
      ) {
        await deleteProject(projectId);
      }
    }
    nav("/");
  }

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
      setBusy(t(`Обрабатываю ${i + 1} из ${files.length}…`, `Processing ${i + 1} of ${files.length}…`));
      try {
        const prep = await prepareImage(file, compression ? compressionOpts(compressionPreset) : {});
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
            ? t(
                "В браузере закончилось место — удалите часть панорам или старые данные.",
                "The browser ran out of storage — delete some panoramas or old data.",
              )
            : t(
                `Не получилось добавить «${file.name}»: ${err.message ?? "неизвестная ошибка"}`,
                `Couldn't add "${file.name}": ${err.message ?? "unknown error"}`,
              );
      }
    }
    await touch();
    setBusy(null);
    setNote(warned);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function linkInCircle() {
    if (list.length < 2) return;
    setBusy(t("Расставляю переходы…", "Placing transitions…"));
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
    setNote(
      t(
        "Переходы расставлены: вправо — следующая панорама, влево — предыдущая. Место можно поправить в туре (карандаш).",
        "Transitions placed: right — next panorama, left — previous. You can adjust placement in the tour (pencil icon).",
      ),
    );
  }

  // Функция «Линейная цепочка переходов»: то же, что «по кругу», но без
  // замыкания — первая панорама без "предыдущей", последняя без "следующей".
  // Кроме добавления недостающих переходов, снимаем замыкающую пару
  // первая↔последняя, если она уже стоит (например, тур до этого был
  // связан «по кругу» — иначе "обратная" ссылка так и осталась бы).
  async function linkInChain() {
    if (list.length < 2) return;
    setBusy(t("Расставляю переходы…", "Placing transitions…"));
    const firstId = list[0].id;
    const lastId = list[list.length - 1].id;
    for (let i = 0; i < list.length; i++) {
      const scene = list[i];
      const next = i < list.length - 1 ? list[i + 1] : null;
      const prev = i > 0 ? list[i - 1] : null;
      const wanted: Hotspot[] = [];
      if (next) wanted.push({ id: uid(), yaw: rad(90), pitch: rad(-8), label: next.title, targetId: next.id });
      if (prev) wanted.push({ id: uid(), yaw: rad(-90), pitch: rad(-8), label: prev.title, targetId: prev.id });
      const add = wanted.filter((w) => !scene.hotspots.some((h) => h.targetId === w.targetId));
      let hotspots = scene.hotspots;
      // При ровно двух панорамах "следующая" и "последняя" — одна и та же
      // сцена, замыкающую пару снимать не с чего.
      if (list.length > 2) {
        if (i === 0) hotspots = hotspots.filter((h) => h.targetId !== lastId);
        if (i === list.length - 1) hotspots = hotspots.filter((h) => h.targetId !== firstId);
      }
      if (add.length || hotspots.length !== scene.hotspots.length) {
        await db.scenes.update(scene.id, { hotspots: [...hotspots, ...add] });
      }
    }
    await touch();
    setBusy(null);
    setNote(
      t(
        "Переходы расставлены по порядку: вправо — следующая панорама, влево — предыдущая. Первая и последняя панорамы соединены только в одну сторону — без цикла.",
        "Transitions placed in order: right — next panorama, left — previous. The first and last panoramas are linked only one-way — no loop.",
      ),
    );
  }

  async function rename(scene: Scene, title: string) {
    await db.scenes.update(scene.id, { title });
    await touch();
  }

  async function renameEn(scene: Scene, titleEn: string) {
    await db.scenes.update(scene.id, { titleEn: titleEn || undefined });
    await touch();
  }

  // Функция «Перетаскивание панорам для сортировки». Держим порядок id во
  // время перетаскивания в отдельном стейте (dragOrder) и позиционируем по
  // реальным координатам карточек (cardRefs), а не по индексу события — так
  // работает и мышью, и пальцем (setPointerCapture ловит move/up, даже если
  // палец уходит за пределы самой ручки).
  function dragStart(e: React.PointerEvent, id: string) {
    if (!dragReorder) return;
    // setPointerCapture кидает исключение, если браузер уже не считает этот
    // pointerId активным (редкий edge-case) — само перетаскивание от этого
    // не зависит, только удобство (move/up ловятся, даже если палец уходит
    // за пределы ручки), поэтому не даём такому сбою сорвать инициализацию.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* см. комментарий выше */
    }
    dragInfoRef.current = { id, pointerId: e.pointerId };
    const initial = list.map((s) => s.id);
    dragOrderRef.current = initial;
    setDragOrder(initial);
    setDraggingId(id);
  }

  function dragMove(e: React.PointerEvent) {
    const info = dragInfoRef.current;
    if (!info) return;
    const y = e.clientY;
    setDragOrder((cur) => {
      if (!cur) return cur;
      let overIndex = cur.length - 1;
      for (let i = 0; i < cur.length; i++) {
        const el = cardRefs.current.get(cur[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { overIndex = i; break; }
      }
      const curIndex = cur.indexOf(info.id);
      if (overIndex === curIndex) return cur;
      const next = [...cur];
      next.splice(curIndex, 1);
      next.splice(overIndex, 0, info.id);
      dragOrderRef.current = next;
      return next;
    });
  }

  async function dragEnd() {
    const info = dragInfoRef.current;
    dragInfoRef.current = null;
    setDraggingId(null);
    const finalOrder = dragOrderRef.current;
    dragOrderRef.current = null;
    setDragOrder(null);
    if (!info || !finalOrder) return;
    const changed = finalOrder.some((id, i) => list[i]?.id !== id);
    if (changed) {
      await Promise.all(finalOrder.map((id, i) => db.scenes.update(id, { order: i })));
      await touch();
    }
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
    if (!window.confirm(t(`Удалить панораму «${scene.title}»?`, `Delete the panorama "${scene.title}"?`))) return;
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

  // Функция «Карта тура»: план — одна картинка на весь проект (как логотип
  // брендинга, но здесь Blob в самом проекте, не data: URI в localStorage —
  // план обычно крупнее и относится к конкретному туру).
  async function updateMapImage(image: Blob | undefined) {
    await db.projects.update(projectId, { mapImage: image, updatedAt: new Date().toISOString() });
  }

  async function updateScenePos(sceneId: string, mapX: number, mapY: number) {
    await db.scenes.update(sceneId, { mapX, mapY });
    await touch();
  }

  async function doExport() {
    setNote(null);
    setBusy(t("Собираю файлы тура…", "Assembling tour files…"));
    try {
      const { blob, filename } = await exportProjectZip(projectId);
      downloadBlob(blob, filename);
      setNote(
        t(
          `Готово: ${filename} скачан. Загрузите содержимое архива на любой статический хостинг (GitHub Pages, Netlify, Vercel) — и тур будет доступен по ссылке.`,
          `Done: ${filename} downloaded. Upload the archive's contents to any static hosting (GitHub Pages, Netlify, Vercel) — and the tour will be available by link.`,
        ),
      );
    } catch (e) {
      setNote(t(`Не удалось собрать экспорт: ${(e as Error).message}`, `Couldn't build the export: ${(e as Error).message}`));
    } finally {
      setBusy(null);
    }
  }

  // Функция «Резервная копия / перенос проекта»: полный редактируемый
  // проект (не готовый тур для просмотра, а всё, что можно снова открыть
  // и редактировать) — на другое устройство или в другой браузер.
  async function doBackupExport() {
    setNote(null);
    setBusy(t("Собираю резервную копию…", "Assembling backup…"));
    try {
      const { blob, filename } = await exportProjectBackup(projectId);
      downloadBlob(blob, filename);
      setNote(
        t(
          `Готово: ${filename} скачан. Это полная копия проекта — храните файл или перенесите на другое устройство через «Импортировать копию» на главном экране.`,
          `Done: ${filename} downloaded. This is a full copy of the project — keep the file or move it to another device via "Import backup" on the home screen.`,
        ),
      );
    } catch (e) {
      setNote(t(`Не удалось собрать копию: ${(e as Error).message}`, `Couldn't build the backup: ${(e as Error).message}`));
    } finally {
      setBusy(null);
    }
  }

  // Функция «QR-код тура»: ссылку на опубликованный тур приложение само не
  // знает (это внешний хостинг) — вводит пользователь, картинку рисуем
  // прямо в браузере пакетом qrcode, без обращений в сеть.
  async function generateQr() {
    const url = qrUrl.trim();
    const canvas = qrCanvasRef.current;
    if (!url || !canvas) return;
    setQrError(null);
    try {
      await renderQrToCanvas(canvas, url);
      setHasQr(true);
    } catch (e) {
      setHasQr(false);
      setQrError((e as Error).message);
    }
  }

  function downloadQr() {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${slugify(project?.title ?? "tour")}-qr.png`);
    });
  }

  const displayList = dragOrder
    ? dragOrder.map((id) => list.find((s) => s.id === id)).filter((s): s is Scene => !!s)
    : list;

  const openScene = openId ? list.find((s) => s.id === openId) : null;

  if (project === undefined) return null;
  if (project === null) {
    return (
      <div className="empty">
        {t("Тур не найден.", "Tour not found.")}
        <div style={{ marginTop: 14 }}>
          <button className="ghost" onClick={() => nav("/")}>{t("← К списку туров", "← Back to tours")}</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button className="back-link" onClick={handleBack}>{t("← Все туры", "← All tours")}</button>
      <input
        type="text"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ fontWeight: 800, fontSize: 22, padding: "8px 10px", marginBottom: 14 }}
        aria-label={t("Название тура", "Tour name")}
      />

      {note && (
        <div className="card banner">
          <div className="row spread" style={{ gap: 8, alignItems: "flex-start" }}>
            <div style={{ lineHeight: 1.5 }}>{note}</div>
            <button className="ghost small" onClick={() => setNote(null)} aria-label={t("Скрыть", "Dismiss")}>✕</button>
          </div>
        </div>
      )}

      <div className="card">
        <button className="primary" style={{ width: "100%" }} disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {t("📷 Добавить панорамы", "📷 Add panoramas")}
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
        <p className="muted" style={{ marginBottom: 0, marginTop: 10, lineHeight: 1.5 }}>
          {t(
            "Подойдёт любой сферический снимок 2:1 — из режима «Панорама 360» на телефоне, с экшн-камеры или из Google Street View.",
            "Any 2:1 spherical shot works — from \"360 Panorama\" mode on a phone, an action camera, or Google Street View.",
          )}
        </p>
        {compression && (
          <select
            value={compressionPreset}
            onChange={(e) => setCompressionPreset(e.target.value as CompressionPresetId)}
            style={{ marginTop: 10 }}
            aria-label={t("Качество при импорте", "Import quality")}
          >
            {COMPRESSION_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{t(p.labelRu, p.labelEn)}</option>
            ))}
          </select>
        )}
      </div>

      {busy && <div className="card center muted">{busy}</div>}

      {list.length > 0 && (
        <>
          <button className="primary" style={{ width: "100%", marginBottom: 8 }} onClick={() => setOpenId(list[0].id)}>{t("▶ Открыть тур", "▶ Open tour")}</button>
          <div className="row wrap" style={{ gap: 8, marginBottom: 11 }}>
            {circleLink && list.length > 1 && <button className="ghost" disabled={!!busy} onClick={linkInCircle}>{t("Связать по кругу", "Link in a circle")}</button>}
            {linearChain && list.length > 1 && <button className="ghost" disabled={!!busy} onClick={linkInChain}>{t("Связать по порядку", "Link in order")}</button>}
            <button className="ghost" disabled={!!busy} onClick={doExport}>{t("⬇ Экспорт", "⬇ Export")}</button>
            {projectBackup && (
              <button className="ghost" disabled={!!busy} onClick={doBackupExport} title={t("Полная копия проекта — для переноса или бэкапа", "Full project copy — for transfer or backup")}>
                {t("💾 Копия", "💾 Backup")}
              </button>
            )}
          </div>

          {qrCode && (
            <div className="card">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("QR-код тура", "Tour QR code")}</div>
              <p className="muted" style={{ marginTop: 0, marginBottom: 8, lineHeight: 1.5 }}>
                {t(
                  "Вставьте ссылку на уже опубликованный тур (после того как загрузите архив «Экспорт» на хостинг) — получите QR-код для печати в отчёте или на объекте.",
                  "Paste a link to an already published tour (after you upload the \"Export\" archive to hosting) — get a QR code to print in a report or on-site.",
                )}
              </p>
              <input
                type="text"
                placeholder="https://..."
                value={qrUrl}
                onChange={(e) => { setQrUrl(e.target.value); setHasQr(false); }}
              />
              <button className="ghost" style={{ marginTop: 8 }} disabled={!qrUrl.trim()} onClick={generateQr}>
                {t("Сгенерировать QR", "Generate QR")}
              </button>
              {qrError && <div style={{ color: "var(--red)", marginTop: 6, fontSize: 13 }}>{qrError}</div>}
              <div style={{ marginTop: 10, textAlign: "center" }}>
                <canvas ref={qrCanvasRef} style={{ display: hasQr ? "inline-block" : "none", maxWidth: "100%" }} />
              </div>
              {hasQr && (
                <button className="ghost small" style={{ marginTop: 8 }} onClick={downloadQr}>
                  {t("⬇ Скачать PNG", "⬇ Download PNG")}
                </button>
              )}
            </div>
          )}

          {mapFeature && (
            <MapEditor
              project={project}
              scenes={list}
              onUpdateMapImage={updateMapImage}
              onUpdateScenePos={updateScenePos}
            />
          )}

          <h2>{t("Панорамы", "Panoramas")} · {list.length} {t("шт", "pcs")} · {sizeMb(list)} {t("МБ", "MB")}</h2>
          {displayList.map((s, i) => (
            <div
              className={`card pano-item${draggingId === s.id ? " dragging" : ""}`}
              key={s.id}
              ref={(el) => { if (el) cardRefs.current.set(s.id, el); else cardRefs.current.delete(s.id); }}
            >
              {dragReorder && (
                <button
                  className="ghost small"
                  style={{ cursor: "grab", touchAction: "none", alignSelf: "center", flexShrink: 0 }}
                  onPointerDown={(e) => dragStart(e, s.id)}
                  onPointerMove={dragMove}
                  onPointerUp={dragEnd}
                  onPointerCancel={dragEnd}
                  aria-label={t("Перетащить для сортировки", "Drag to reorder")}
                  title={t("Перетащите, чтобы переставить", "Drag to reorder")}
                >
                  ⠿
                </button>
              )}
              <button className="pano-thumb" onClick={() => setOpenId(s.id)} title={t("Открыть", "Open")}>
                {thumbs[s.id] ? <img src={thumbs[s.id]} alt="" /> : <span className="muted">…</span>}
              </button>
              <div className="grow">
                <input type="text" value={s.title} onChange={(e) => rename(s, e.target.value)} aria-label={t("Название панорамы", "Panorama name")} />
                {i18n && (
                  <input
                    type="text"
                    value={s.titleEn ?? ""}
                    onChange={(e) => renameEn(s, e.target.value)}
                    placeholder={t("English title (необязательно)", "English title (optional)")}
                    aria-label={t("Название по-английски", "Title in English")}
                    style={{ marginTop: 6 }}
                  />
                )}
                <div className="muted" style={{ marginTop: 6 }}>{s.width}×{s.height} · {t("переходов", "transitions")}: {s.hotspots.length}</div>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <button className="ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("Выше", "Move up")}>↑</button>
                  <button className="ghost small" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={t("Ниже", "Move down")}>↓</button>
                  <button className="ghost small grow" onClick={() => setOpenId(s.id)}>{t("Открыть", "Open")}</button>
                  <button className="ghost small" onClick={() => remove(s)} aria-label={t("Удалить", "Delete")}>🗑</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {list.length === 0 && !busy && (
        <div className="empty">{t("Добавьте первую панораму, чтобы начать собирать тур.", "Add the first panorama to start building the tour.")}</div>
      )}

      {openScene && (
        <PanoViewer scenes={list} startId={openScene.id} editable onClose={() => setOpenId(null)} onChange={saveScene} mapImage={project.mapImage} />
      )}
    </div>
  );
}
