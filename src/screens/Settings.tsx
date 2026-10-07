import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FEATURES, setFeatureEnabled, useFeature, type FeatureFlag } from "../features";
import { isDefaultLogo, setBranding, useBranding } from "../branding";
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

// Брендинг тура: логотип и подпись в углу опубликованных туров. Всегда
// включён; по умолчанию — логотип ZYXED, можно заменить своим.
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
    <div className="card" style={{ marginBottom: 16 }}>
      <b>{t("Брендинг тура", "Tour branding")}</b>
      <p className="muted" style={{ margin: "4px 0 10px", lineHeight: 1.5, fontSize: 13 }}>
        {t(
          "Логотип и подпись в углу каждого опубликованного тура (и в предпросмотре). По умолчанию — логотип ZYXED Engineering; можно заменить своим — одна пара на все туры.",
          "Logo and caption in the corner of every published tour (and in the preview). ZYXED Engineering logo by default; you can replace it with your own — one pair for all tours.",
        )}
      </p>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <div
          style={{
            width: 56, height: 56, borderRadius: 10, flexShrink: 0,
            background: "#0a1420", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
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
            {busy ? t("Загружаю…", "Uploading…") : t("Заменить логотип", "Replace logo")}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {!isDefaultLogo(branding.logo) && (
            <button className="ghost small" style={{ marginLeft: 6 }} onClick={() => setBranding({ logo: undefined })}>
              {t("↺ логотип ZYXED", "↺ ZYXED logo")}
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
          "Меняет язык интерфейса приложения и кнопок в экспортированном туре. Ваши названия панорам и заметки не переводятся — показываются как вписаны.",
          "Changes the language of the app interface and of the buttons in an exported tour. Your panorama titles and notes are not translated — they are shown as you typed them.",
        )}
      </p>
    </div>
  );
}

export default function Settings() {
  const nav = useNavigate();
  const t = useT();
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
        <FeatureRow key={f.id} feature={f} />
      ))}
      <BrandingEditor />
    </div>
  );
}
