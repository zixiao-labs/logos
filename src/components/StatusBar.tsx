import { useStore } from "../state/store";
import { useT } from "../i18n";
import { Icon } from "./Icon";

export function StatusBar() {
  const t = useT();
  const git = useStore((s) => s.git);
  const layout = useStore((s) => s.settings["workbench.layout"]);
  const language = useStore((s) => s.settings["workbench.language"]);
  const cursor = useStore((s) => s.cursor);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const diagnostics = useStore((s) => s.diagnostics);
  const toggleLayout = useStore((s) => s.toggleLayout);
  const toggleLanguage = useStore((s) => s.toggleLanguage);
  const togglePanel = useStore((s) => s.togglePanel);
  const tabSize = useStore((s) => s.settings["editor.tabSize"]);

  const active = tabs.find((tb) => tb.id === activeTabId);

  let errors = 0;
  let warnings = 0;
  for (const list of Object.values(diagnostics)) {
    for (const d of list) {
      if (d.severity === 1) errors++;
      else if (d.severity === 2) warnings++;
    }
  }

  return (
    <div className="statusbar">
      {git?.isRepo && (
        <button className="si" onClick={togglePanel} title={git.branch ?? ""}>
          <Icon name="branch" size={13} />
          {git.branch}
          {git.ahead > 0 ? ` ↑${git.ahead}` : ""}
          {git.behind > 0 ? ` ↓${git.behind}` : ""}
        </button>
      )}
      <button className="si" onClick={togglePanel}>
        <Icon name="error" size={13} /> {errors}
        <Icon name="warning" size={13} style={{ marginLeft: 6 }} /> {warnings}
      </button>
      <div className="spacer" />
      {active?.kind === "file" && (
        <>
          <span className="si">
            {t("status.ln")} {cursor.line}, {t("status.col")} {cursor.col}
          </span>
          <span className="si">
            {t("status.spaces")}: {tabSize}
          </span>
          <span className="si">{active.language}</span>
        </>
      )}
      <button className="si" onClick={toggleLanguage} title={t("settings.language")}>
        <Icon name="translate" size={13} /> {language.toUpperCase()}
      </button>
      <button className="si" onClick={toggleLayout}>
        <Icon name="layout" size={13} />
        {layout === "vscode" ? t("status.layout.vscode") : t("status.layout.cursor")}
      </button>
    </div>
  );
}
