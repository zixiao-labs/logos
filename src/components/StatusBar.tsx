import { useStore } from "../state/store";
import { useT } from "../i18n";
import { serverIdForLanguage } from "../lib/language";
import { Icon, type IconName } from "./Icon";

export function StatusBar() {
  const t = useT();
  const git = useStore((s) => s.git);
  const layout = useStore((s) => s.settings["workbench.layout"]);
  const language = useStore((s) => s.settings["workbench.language"]);
  const cursor = useStore((s) => s.cursor);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const diagnostics = useStore((s) => s.diagnostics);
  const lsp = useStore((s) => s.lsp);
  const agentSessions = useStore((s) => s.agentSessions);
  const toggleLayout = useStore((s) => s.toggleLayout);
  const toggleLanguage = useStore((s) => s.toggleLanguage);
  const togglePanel = useStore((s) => s.togglePanel);
  const openSpecial = useStore((s) => s.openSpecial);
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

  // C1: language-server status for the active file.
  const serverId =
    active?.kind === "file" && active.language
      ? serverIdForLanguage(active.language)
      : null;
  const lspStatus = serverId ? lsp[serverId]?.status : undefined;
  let lspText = "";
  let lspIcon: IconName = "extensions";
  let lspDanger = false;
  if (serverId) {
    if (lspStatus === "running") {
      lspIcon = "check";
      lspText = "LSP";
    } else if (lspStatus === "installing") {
      lspText = t("lsp.installing");
    } else if (lspStatus === "starting" || lspStatus === "installed") {
      lspText = t("lsp.starting");
    } else if (lspStatus === "error") {
      lspIcon = "error";
      lspText = t("lsp.error");
      lspDanger = true;
    } else {
      lspText = t("lsp.install"); // not-installed / unknown
    }
  }

  const agentRunning = agentSessions.some((a) => a.status === "running");

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
      {agentRunning && (
        <button
          className="si"
          onClick={() => useStore.setState({ secondaryVisible: true })}
          title={t("agent.running")}
        >
          <Icon name="agent" size={13} className="spin" /> {t("agent.running")}
        </button>
      )}
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
          {serverId && (
            <button
              className={`si ${lspDanger ? "lsp-danger" : ""}`}
              onClick={() => openSpecial("extensions")}
              title={
                (serverId && lsp[serverId]?.message) || t("lsp.title")
              }
            >
              <Icon name={lspIcon} size={13} /> {lspText}
            </button>
          )}
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
