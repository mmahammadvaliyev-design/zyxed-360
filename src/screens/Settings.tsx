import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FEATURES, setFeatureEnabled, useFeature, type FeatureFlag } from "../features";
import { setBranding, useBranding } from "../branding";
import { setAppLanguage, useAppLanguage } from "../appLanguage";
import { prepareBrandingLogo } from "../imageImport";
import { useT } from "../i18n";

function FeatureRow({ feature }: { feature: FeatureFlag }) {
  const on = useFeature(feature.id);
  const lang = useAppLanguage();
  const label = lang === "en" ? feature.labelEn : feature.label;
  const description = lang === "en" ? feature.descriptionEn : feature.description;
  return (
    <div className="card row spread" style={{ alignItems: "flex-start", gap: 12 }}>
      <div className="grow">
        <div style={{ fontWeight: 700, marginBottom: 3 }}>{label}</div>
        <div className="muted" style={{ lineHeight: 1.5 }}>{description}</div>
      </div>
      <button
        className={`switch${on ? " on" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setFeatureEnabled(feature.id, !on)}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

// Настройка логотипа/подписи для функции «Брендинг тура» — показывается
// сразу под её тумблером, пока он включён.
function BrandingEditor() {
  const t = useT();
  const branding = useBranding();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const logo = await prepareBrandingLogo(file);
      setBranding({ logo });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="card" style={{ marginTop: -5, marginBottom: 11 }}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <div
          style={{
            width: 56, height: 56, borderRadius: 10, flexShrink: 0,
            background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
          }}
        >
          {branding.logo ? (
            <img src={branding.logo} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          ) : (
            <span className="muted" style={{ fontSize: 10 }}>{t("нет лого", "no logo")}</span>
          )}
        </div>
        <div className="grow">
          <label className="ghost small" style={{ cursor: "pointer", display: "inline-block" }}>
            {busy ? t("Загружаю…", "Uploading…") : branding.logo ? t("Заменить логотип", "Replace logo") : t("+ Логотип", "+ Logo")}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {branding.logo && (
            <button className="ghost small" style={{ marginLeft: 6 }} onClick={() => setBranding({ logo: undefined })}>
              {t("✕ убрать", "✕ remove")}
            </button>
          )}
        </div>
      </div>
      <input
        type="text"
        placeholder={t("Подпись (необязательно) — например «ZYXED Engineering»", "Caption (optional) — e.g. \"ZYXED Engineering\"")}
        value={branding.text ?? ""}
        onChange={(e) => setBranding({ text: e.target.value })}
        style={{ marginTop: 10 }}
      />
    </div>
  );
}

// Язык приложения — основная настройка, не спрятана за тумблером: выбор
// здесь сразу меняет весь интерфейс приложения, и на каком языке соберётся
// следующий экспорт. Никакого переключателя внутри самого тура нет — только
// сам выбор из двух языков. Функция «RU/EN тур» ниже — отдельная, необязательная
// штука (английские поля для содержимого тура), язык приложения от неё не зависит.
function LanguageSelector() {
  const t = useT();
  const lang = useAppLanguage();
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{t("Язык приложения", "App language")}</div>
      <div className="row" style={{ gap: 6 }}>
        <button className={lang === "ru" ? "primary" : "ghost"} style={{ flex: 1 }} onClick={() => setAppLanguage("ru")}>
          Русский
        </button>
        <button className={lang === "en" ? "primary" : "ghost"} style={{ flex: 1 }} onClick={() => setAppLanguage("en")}>
          English
        </button>
      </div>
      <p className="muted" style={{ marginTop: 10, marginBottom: 0, lineHeight: 1.5, fontSize: 13 }}>
        {t(
          "Меняет язык всего интерфейса приложения. Для содержимого тура (названия панорам, подписи переходов) переключает только те, где в редакторе заполнено поле «English title» / «Label (English)» — пока оно пустое, показывается русский текст.",
          "Changes the language of the whole app interface. For tour content (panorama titles, transition labels) it only switches ones where the \"English title\" / \"Label (English)\" field is filled in — while it's empty, the Russian text is shown.",
        )}
      </p>
    </div>
  );
}

export default function Settings() {
  const nav = useNavigate();
  const t = useT();
  const brandingOn = useFeature("branding");
  return (
    <div>
      <button className="back-link" onClick={() => nav("/")}>{t("← Мои туры", "← My tours")}</button>
      <h1>{t("Настройки", "Settings")}</h1>
      <LanguageSelector />
      <p className="muted" style={{ marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>
        {t(
          "Дополнительные функции — каждую можно включить или выключить отдельно. Состояние применяется и здесь, в редакторе/просмотре, и в турах, которые вы экспортируете после этого.",
          "Additional features — each can be turned on or off independently. The state applies here, in the editor/viewer, and in tours you export afterwards.",
        )}
      </p>
      {FEATURES.map((f) => (
        <div key={f.id}>
          <FeatureRow feature={f} />
          {f.id === "branding" && brandingOn && <BrandingEditor />}
        </div>
      ))}
    </div>
  );
}
