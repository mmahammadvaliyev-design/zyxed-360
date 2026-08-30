import { useEffect, useRef, useState } from "react";
import type { Project, Scene } from "../db";
import { prepareMapImage } from "../imageImport";
import { useT } from "../i18n";

interface Props {
  project: Project;
  scenes: Scene[];
  onUpdateMapImage: (image: Blob | undefined) => Promise<void>;
  onUpdateScenePos: (sceneId: string, mapX: number, mapY: number) => Promise<void>;
}

// Точка не перетаскивается — перетаскивание мелкой мишени оказалось неудобным
// (жалоба "расставление сфер очень сложное"). Вместо этого — два нажатия:
// выбрали панораму в списке ("вооружили" её), потом нажали на нужное место
// на плане. Уже стоящую точку можно нажать прямо на плане, чтобы выбрать
// её и переставить — так же, как из списка.
export default function MapEditor({ project, scenes, onUpdateMapImage, onUpdateScenePos }: Props) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);

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

  async function placeArmed(e: React.MouseEvent) {
    if (!armedId) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    const id = armedId;
    setArmedId(null);
    await onUpdateScenePos(id, x, y);
  }

  const armedScene = scenes.find((s) => s.id === armedId);

  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("Карта тура", "Tour map")}</div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 8, lineHeight: 1.5 }}>
        {t(
          "Загрузите план объекта. Нажмите на панораму в списке ниже, затем нажмите на нужное место на плане — точка встанет туда. Уже стоящую точку можно нажать прямо на плане, чтобы переставить.",
          "Upload a site plan. Tap a panorama in the list below, then tap the spot on the plan — the point lands there. An already placed point can be tapped right on the plan to move it.",
        )}
      </p>
      <label className="ghost small" style={{ cursor: "pointer", display: "inline-block" }}>
        {busy ? t("Загружаю…", "Uploading…") : mapUrl ? t("Заменить план", "Replace plan") : t("+ Загрузить план", "+ Upload plan")}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickMap(e.target.files?.[0])} />
      </label>
      {mapUrl && (
        <button className="ghost small" style={{ marginLeft: 6 }} onClick={() => { onUpdateMapImage(undefined); setArmedId(null); }}>
          {t("✕ убрать", "✕ remove")}
        </button>
      )}

      {mapUrl && (
        <>
          <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
            {scenes.map((s) => {
              const placed = s.mapX != null && s.mapY != null;
              return (
                <button
                  key={s.id}
                  className={armedId === s.id ? "primary small" : "ghost small"}
                  onClick={() => setArmedId(armedId === s.id ? null : s.id)}
                >
                  {placed ? "📍 " : "○ "}{s.title}
                </button>
              );
            })}
          </div>
          {armedScene && (
            <p className="muted" style={{ fontSize: 13, marginTop: 6, marginBottom: 0 }}>
              {t(`Нажмите на карте, куда поставить «${armedScene.title}»`, `Tap the plan where to place "${armedScene.title}"`)}
            </p>
          )}

          <div
            ref={frameRef}
            style={{ position: "relative", marginTop: 10, lineHeight: 0, cursor: armedId ? "crosshair" : "default" }}
            onClick={placeArmed}
          >
            <img src={mapUrl} alt="" style={{ width: "100%", display: "block", borderRadius: 10 }} />
            {scenes.map((s) => {
              if (s.mapX == null || s.mapY == null) return null;
              return (
                <button
                  key={s.id}
                  className={`pano-map-pin${armedId === s.id ? " on" : ""}`}
                  style={{ left: `${s.mapX}%`, top: `${s.mapY}%` }}
                  onClick={(e) => { e.stopPropagation(); setArmedId(armedId === s.id ? null : s.id); }}
                  title={s.title}
                >
                  <span className="pano-map-pin-label">{s.title}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
