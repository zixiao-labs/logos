import { useEffect, useRef } from "react";
import { useStore, type PanelTab } from "../state/store";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { Icon } from "./Icon";
import { TerminalView } from "./TerminalView";

const TABS: { id: PanelTab; key: string }[] = [
  { id: "problems", key: "panel.problems" },
  { id: "output", key: "panel.output" },
  { id: "debug", key: "panel.debug" },
  { id: "terminal", key: "panel.terminal" },
  { id: "ports", key: "panel.ports" },
];

export function Panel() {
  const t = useT();
  const panelTab = useStore((s) => s.panelTab);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const togglePanel = useStore((s) => s.togglePanel);
  const terminals = useStore((s) => s.terminals);
  const activeTerminalId = useStore((s) => s.activeTerminalId);
  const newTerminal = useStore((s) => s.newTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const setActiveTerminal = useStore((s) => s.setActiveTerminal);
  const diagnostics = useStore((s) => s.diagnostics);
  const openFile = useStore((s) => s.openFile);
  const lspLogs = useStore((s) => s.lspLogs);
  const clearLspLogs = useStore((s) => s.clearLspLogs);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelTab !== "output") return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [panelTab, lspLogs.length]);

  return (
    <div className="bottom-panel" style={{ height: "100%" }}>
      <div className="bottom-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`bottom-tab ${panelTab === tab.id ? "active" : ""}`}
            onClick={() => setPanelTab(tab.id)}
          >
            {t(tab.key)}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {panelTab === "terminal" && (
          <button
            className="icon-btn"
            title={t("panel.newTerminal")}
            onClick={() => void newTerminal()}
          >
            <Icon name="add" />
          </button>
        )}
        {panelTab === "output" && lspLogs.length > 0 && (
          <button className="btn ghost" style={{ width: "auto" }} onClick={clearLspLogs}>
            {t("panel.clear")}
          </button>
        )}
        <button className="icon-btn" title={t("editor.close")} onClick={togglePanel}>
          <Icon name="chevron-down" />
        </button>
      </div>

      <div className="bottom-content">
        {panelTab === "terminal" && (
          <div className="terminal-wrap">
            {terminals.length === 0 ? (
              <div className="empty-state">
                <button className="btn" style={{ width: "auto" }} onClick={() => void newTerminal()}>
                  <Icon name="terminal" /> {t("panel.newTerminal")}
                </button>
              </div>
            ) : (
              <>
                <div className="terminal-views">
                  {terminals.map((term) => (
                    <TerminalView
                      key={term.id}
                      id={term.id}
                      active={term.id === activeTerminalId}
                    />
                  ))}
                </div>
                <div className="terminal-tabs">
                  {terminals.map((term) => (
                    <div
                      key={term.id}
                      className={`terminal-tab ${
                        term.id === activeTerminalId ? "active" : ""
                      }`}
                      onClick={() => setActiveTerminal(term.id)}
                    >
                      <Icon name="terminal" size={13} />
                      <span style={{ flex: 1, overflow: "hidden" }}>
                        {term.name}
                      </span>
                      <span
                        className="icon-btn"
                        style={{ width: 18, height: 18 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminal(term.id);
                        }}
                      >
                        <Icon name="close" size={12} />
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {panelTab === "problems" && (
          <div className="scroll-y" style={{ padding: "8px 12px" }}>
            {Object.entries(diagnostics).filter(([, d]) => d.length > 0).length ===
            0 ? (
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {t("panel.noProblems")}
              </div>
            ) : (
              Object.entries(diagnostics).map(([path, diags]) =>
                diags.length === 0 ? null : (
                  <div key={path} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        margin: "4px 0",
                        cursor: "pointer",
                      }}
                      onClick={() => openFile(path)}
                    >
                      {basename(path)}{" "}
                      <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                        {diags.length}
                      </span>
                    </div>
                    {diags.map((d, i) => (
                      <div
                        key={i}
                        className="search-result"
                        onClick={() => openFile(path)}
                      >
                        <Icon
                          name={d.severity === 1 ? "error" : "warning"}
                          size={13}
                          style={{
                            color:
                              d.severity === 1
                                ? "var(--danger)"
                                : "var(--warning)",
                            verticalAlign: "-2px",
                            marginRight: 6,
                          }}
                        />
                        {d.message}{" "}
                        <span className="path">
                          [{d.startLine}:{d.startCol}]
                        </span>
                      </div>
                    ))}
                  </div>
                ),
              )
            )}
          </div>
        )}

        {panelTab === "output" && (
          <div
            ref={outputRef}
            className="scroll-y"
            style={{
              padding: 12,
              color: "var(--muted)",
              fontFamily: "var(--mono-font)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {lspLogs.length === 0 ? (
              t("panel.noOutput")
            ) : (
              <>
                <div style={{ color: "var(--foreground)", marginBottom: 8 }}>
                  {t("lsp.title")}
                </div>
                {lspLogs.map((entry, i) => {
                  const time = new Date(entry.time).toLocaleTimeString();
                  const source = entry.serverId ? `[${entry.serverId}] ` : "";
                  return (
                    <div
                      key={`${entry.time}-${i}`}
                      style={{
                        color:
                          entry.level === "error"
                            ? "var(--danger)"
                            : entry.level === "warning"
                              ? "var(--warning)"
                              : "var(--muted)",
                      }}
                    >
                      [{time}] {source}{entry.message}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {(panelTab === "debug" || panelTab === "ports") && (
          <div
            className="scroll-y"
            style={{
              padding: 12,
              color: "var(--muted)",
              fontFamily: "var(--mono-font)",
              fontSize: 12,
            }}
          >
            {panelTab === "debug" && "Debugging arrives in Stage 3.5 (DAP)."}
            {panelTab === "ports" && "No forwarded ports."}
          </div>
        )}
      </div>
    </div>
  );
}
