import { useNavigate } from "react-router-dom";
import { FEATURES, setFeatureEnabled, useFeature, type FeatureFlag } from "../features";

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

export default function Settings() {
  const nav = useNavigate();
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
        <FeatureRow key={f.id} feature={f} />
      ))}
    </div>
  );
}
