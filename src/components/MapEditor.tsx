import { useEffect, useRef, useState } from "react";
import type { Project, Scene } from "../db";
import { prepareMapImage } from "../imageImport";
import { useT } from "../i18n";

const TAP_SLOP = 6;

// Точки без mapX/mapY ещё не расставлены вручную — раскладываем их по
// строкам сеткой у верхнего края плана, чтобы все были видны и доступны
// для перетаскивания порознь, а не сложены в одну кучу в центре.
function defaultPos(index: number, total: number): { x: number; y: number } {
  const cols = Math.min(total, 6);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = cols <= 1 ? 50 : 10 + (col * 80) / (cols - 1);
  return { x, y: Math.min(10 + row * 14, 90) };
}

interface Props {
  project: Project;
  scenes: Scene[];
  onUpdateMapImage: (image: Blob | undefined) => Promise<void>;
  onUpdateScenePos: (sceneId: string, mapX: number, mapY: number) => Promise<void>;
  onOpenScene: (sceneId: string) => void;
}

export default function MapEditor({ project, scenes, onUpdateMapImage, onUpdateScenePos, onOpenScene }: Props) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragInfo = useRef<{ id: string; moved: number; x: number; y: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!project.mapImage) {
      setMapUrl(null);
      return;
    }
    const url = URL.createObjectURL(project.mapImage);
    setMapUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [project.mapImage]);

  async function pickMap(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const image = await prepareMapImage(file);
      await onUpdateMapImage(image);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function posFor(s: Scene, index: number): { x: number; y: number } {
    if (draggingId === s.id && dragPos) return dragPos;
    if (s.mapX != null && s.mapY != null) return { x: s.mapX, y: s.mapY };
    return defaultPos(index, scenes.length);
  }

  function pointerDown(e: React.PointerEvent, id: string) {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragInfo.current = { id, moved: 0, x: e.clientX, y: e.clientY };
    setDraggingId(id);
  }

  function pointerMove(e: React.PointerEvent) {
    const info = dragInfo.current;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!info || !rect) return;
    info.moved += Math.abs(e.clientX - info.x) + Math.abs(e.clientY - info.y);
    info.x = e.clientX;
    info.y = e.clientY;
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    setDragPos({ x, y });
  }

  async function pointerUp() {
    const info = dragInfo.current;
    dragInfo.current = null;
    setDraggingId(null);
    if (!info) return;
    if (info.moved < TAP_SLOP) {
      onOpenScene(info.id);
      setDragPos(null);
      return;
    }
    const pos = dragPos;
    setDragPos(null);
    if (pos) await onUpdateScenePos(info.id, pos.x, pos.y);
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("Карта тура", "Tour map")}</div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 8, lineHeight: 1.5 }}>
        {t(
          "Загрузите план объекта и перетащите точки на нужные места. Клик по точке без перетаскивания открывает панораму.",
          "Upload a site plan and drag the points to the right spots. Clicking a point without dragging opens the panorama.",
        )}
      </p>
      <label className="ghost small" style={{ cursor: "pointer", display: "inline-block" }}>
        {busy ? t("Загружаю…", "Uploading…") : mapUrl ? t("Заменить план", "Replace plan") : t("+ Загрузить план", "+ Upload plan")}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickMap(e.target.files?.[0])} />
      </label>
      {mapUrl && (
        <button className="ghost small" style={{ marginLeft: 6 }} onClick={() => onUpdateMapImage(undefined)}>
          {t("✕ убрать", "✕ remove")}
        </button>
      )}

      {mapUrl && (
        <div
          ref={frameRef}
          style={{ position: "relative", marginTop: 10, lineHeight: 0, touchAction: "none" }}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        >
          <img src={mapUrl} alt="" style={{ width: "100%", display: "block", borderRadius: 10 }} />
          {scenes.map((s, i) => {
            const pos = posFor(s, i);
            return (
              <button
                key={s.id}
                className={`pano-map-pin${draggingId === s.id ? " dragging" : ""}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                onPointerDown={(e) => pointerDown(e, s.id)}
                title={s.title}
              >
                <span className="pano-map-pin-label">{s.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
