import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FEATURES, setFeatureEnabled, useFeature, type FeatureFlag } from "../features";
import { setBranding, useBranding } from "../branding";
import { setAppLanguage, useAppLanguage } from "../appLanguage";
import { prepareBrandingLogo } from "../imageImport";

function FeatureRow({ feature }: { feature: FeatureFlag }) {
  const on = useFeature(feature.id);
  return (
    <div className="card row spread" style={{ alignItems: "flex-start", gap: 12 }}>
      <div className="grow">
        <div style={{ fontWeight: 700, marginBottom: 3 }}>{feature.label}</div>
        <div className="muted" style={{ lineHeight: 1.5 }}>{feature.description}</div>
      </div>
      <button
        className={`switch${on ? " on" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label={feature.label}
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
            <span className="muted" style={{ fontSize: 10 }}>нет лого</span>
          )}
        </div>
        <div className="grow">
          <label className="ghost small" style={{ cursor: "pointer", display: "inline-block" }}>
            {busy ? "Загружаю…" : branding.logo ? "Заменить логотип" : "+ Логотип"}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {branding.logo && (
            <button className="ghost small" style={{ marginLeft: 6 }} onClick={() => setBranding({ logo: undefined })}>
              ✕ убрать
            </button>
          )}
        </div>
      </div>
      <input
        type="text"
        placeholder="Подпись (необязательно) — например «ZYXED Engineering»"
        value={branding.text ?? ""}
        onChange={(e) => setBranding({ text: e.target.value })}
        style={{ marginTop: 10 }}
      />
    </div>
  );
}

// Язык приложения для функции «RU/EN тур» — выбор здесь сразу меняет, какой
// вариант (RU/EN) показывается в приложении, и на каком языке соберётся
// следующий экспорт. Никакого переключателя внутри самого тура больше нет.
function LanguageSelector() {
  const lang = useAppLanguage();
  return (
    <div className="card" style={{ marginTop: -5, marginBottom: 11 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Язык приложения</div>
      <div className="row" style={{ gap: 6 }}>
        <button className={lang === "ru" ? "primary" : "ghost"} style={{ flex: 1 }} onClick={() => setAppLanguage("ru")}>
          Русский
        </button>
        <button className={lang === "en" ? "primary" : "ghost"} style={{ flex: 1 }} onClick={() => setAppLanguage("en")}>
          English
        </button>
      </div>
    </div>
  );
}

export default function Settings() {
  const nav = useNavigate();
  const brandingOn = useFeature("branding");
  const i18nOn = useFeature("i18n");
  return (
    <div>
      <button className="back-link" onClick={() => nav("/")}>← Мои туры</button>
      <h1>Настройки</h1>
      <p className="muted" style={{ marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>
        Дополнительные функции — каждую можно включить или выключить отдельно.
        Состояние применяется и здесь, в редакторе/просмотре, и в турах,
        которые вы экспортируете после этого.
      </p>
      {FEATURES.map((f) => (
        <div key={f.id}>
          <FeatureRow feature={f} />
          {f.id === "branding" && brandingOn && <BrandingEditor />}
          {f.id === "i18n" && i18nOn && <LanguageSelector />}
        </div>
      ))}
    </div>
  );
}
