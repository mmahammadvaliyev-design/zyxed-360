import { useT } from "../i18n";
import { chooseFolderForProject, FOLDER_SUPPORTED, grantFolderAccess, syncNow, useFolderStatus } from "../folderSync";

// Строка состояния папки тура в редакторе: куда сохраняется копия и когда
// последний раз. Если папки нет — предлагает выбрать; если браузер «забыл»
// разрешение — кнопка «Разрешить доступ».
export default function FolderBar({ projectId, title, onNote }: { projectId: string; title: string; onNote: (msg: string) => void }) {
  const t = useT();
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
        {st.state === "syncing" && <span className="muted">· {t("сохраняю…", "saving…")}</span>}
        {st.state === "idle" && <span className="muted">· {t("ожидание", "waiting")}</span>}
        {st.state === "needs-permission" && <span className="muted">· {t("браузер просит подтвердить доступ к папке", "the browser needs you to confirm folder access")}</span>}
        {st.state === "error" && <span style={{ color: "var(--danger, #c33)" }}>· {t("ошибка", "error")}: {st.error}</span>}
      </div>
      {st.state === "needs-permission" && <button className="primary small" onClick={() => grantFolderAccess(projectId)}>{t("Разрешить доступ", "Allow access")}</button>}
      {st.state === "error" && <button className="ghost small" onClick={() => syncNow(projectId)}>{t("Повторить", "Retry")}</button>}
    </div>
  );
}
