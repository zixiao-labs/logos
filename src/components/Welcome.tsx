import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { Icon } from "./Icon";

export function Welcome() {
  const t = useT();
  const recent = useStore((s) => s.recent);
  const openFolder = useStore((s) => s.openFolder);
  const setRoot = useStore((s) => s.setRoot);
  const newAgentSession = useStore((s) => s.newAgentSession);
  const setSidebarView = useStore((s) => s.setSidebarView);

  return (
    <div className="welcome">
      <h1>{t("app.welcome")}</h1>
      <div className="tagline">{t("app.tagline")}</div>
      <div className="welcome-actions">
        <button className="btn" onClick={openFolder}>
          <Icon name="folder" /> {t("welcome.openFolder")}
        </button>
        <button
          className="btn secondary"
          onClick={() => {
            newAgentSession();
            setSidebarView("agent");
          }}
        >
          <Icon name="agent" /> {t("welcome.newAgent")}
        </button>
      </div>
      {recent.length > 0 && (
        <div style={{ marginTop: 28, minWidth: 320 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 8,
            }}
          >
            {t("welcome.recent")}
          </div>
          {recent.slice(0, 6).map((r) => (
            <div
              key={r}
              className="search-result"
              onClick={() => void setRoot(r)}
            >
              <span style={{ color: "var(--accent)" }}>{basename(r)}</span>{" "}
              <span className="path">{r}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
