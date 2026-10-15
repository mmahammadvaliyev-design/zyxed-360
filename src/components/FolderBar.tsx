import { useNavigate } from "react-router-dom";
import { useT } from "../i18n";
import { chooseFolderForProject, FOLDER_SUPPORTED, grantFolderAccess, resolveConflictImport, resolveConflictOverwrite, syncNow, useFolderStatus } from "../folderSync";

// Строка состояния папки тура в редакторе: куда сохраняется копия и когда
// последний раз. Если папки нет — предлагает выбрать; если браузер «забыл»
// разрешение — кнопка «Разрешить доступ».
export default function FolderBar({ projectId, title, onNote }: { projectId: string; title: string; onNote: (msg: string) => void }) {
  const t = useT();
  const nav = useNavigate();
  const st = useFolderStatus(projectId);
  if (!FOLDER_SUPPORTED) return null;

  async function choose() {
    try {
      await chooseFolderForProject(projectId, title);
    } catch (e) {
      onNote(t(`Не удалось привязать папку: ${(e as Error).message}`, `Couldn't link the folder: ${(e as Error).message}`));
    }
  }

  if (!st.linked) {
    return (
      <div className="card row spread" style={{ gap: 8, marginBottom: 11, alignItems: "center" }}>
        <div className="muted" style={{ lineHeight: 1.45 }}>
          📁 {t("Тур хранится только в браузере. Привяжите папку — копия будет сохраняться в неё автоматически.", "The tour is stored only in the browser. Link a folder — a copy will be saved there automatically.")}
        </div>
        <button className="ghost small" onClick={choose}>{t("Выбрать папку…", "Choose folder…")}</button>
      </div>
    );
  }

  const time = st.syncedAt ? new Date(st.syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="card row spread" style={{ gap: 8, marginBottom: 11, alignItems: "center" }}>
      <div style={{ lineHeight: 1.45, minWidth: 0 }}>
        📁 <b>{st.folderName}</b>{" "}
        {st.state === "synced" && <span className="muted">· {t("сохранено", "saved")} {time} ✓</span>}
        {st.state === "synced" && st.viewerBusy && <span className="muted"> · {t("обновляю index.html…", "updating index.html…")}</span>}
        {st.state === "synced" && !st.viewerBusy && st.viewerAt && (
          <span className="muted"> · {t("index.html для просмотра обновлён", "viewable index.html updated")} {new Date(st.viewerAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        )}
        {st.state === "syncing" && <span className="muted">· {t("сохраняю…", "saving…")}</span>}
        {st.state === "idle" && <span className="muted">· {t("ожидание", "waiting")}</span>}
        {st.state === "needs-permission" && <span className="muted">· {t("браузер просит подтвердить доступ к папке", "the browser needs you to confirm folder access")}</span>}
        {st.state === "conflict" && (
          <span style={{ color: "var(--danger, #c33)" }}>
            · {t("в папке есть изменения не от этой программы (другой компьютер или восстановление из архива) — автосохранение остановлено, чтобы не затереть их", "the folder was changed outside this app (another computer or a restore) — autosave is paused so they aren't overwritten")}
          </span>
        )}
        {st.state === "error" && <span style={{ color: "var(--danger, #c33)" }}>· {t("ошибка", "error")}: {st.error}</span>}
        {st.viewerError && <div style={{ color: "var(--danger, #c33)" }}>{t("index.html для просмотра не обновлён", "viewable index.html not updated")}: {st.viewerError}</div>}
      </div>
      {st.state === "conflict" && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button
            className="ghost small"
            onClick={async () => {
              const id = await resolveConflictImport(projectId);
              if (id) nav(`/p/${id}`);
            }}
          >
            {t("Загрузить из папки отдельным туром", "Load the folder's version as a new tour")}
          </button>
          <button
            className="primary small"
            onClick={() => {
              if (window.confirm(t("Заменить содержимое папки версией из этой программы? Изменения в папке будут потеряны.", "Replace the folder's contents with this app's version? Changes in the folder will be lost."))) void resolveConflictOverwrite(projectId);
            }}
          >
            {t("Заменить папку моей версией", "Overwrite the folder")}
          </button>
        </div>
      )}
      {st.state === "needs-permission" && <button className="primary small" onClick={() => grantFolderAccess(projectId)}>{t("Разрешить доступ", "Allow access")}</button>}
      {st.state === "error" && <button className="ghost small" onClick={() => syncNow(projectId)}>{t("Повторить", "Retry")}</button>}
    </div>
  );
}
