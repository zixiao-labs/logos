import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, type PanelTab } from "../state/store";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import type { LspLog, LspLogLevel } from "../shared/types";
import { Icon } from "./Icon";
import { TerminalView } from "./TerminalView";

const TABS: { id: PanelTab; key: string }[] = [
  { id: "problems", key: "panel.problems" },
  { id: "output", key: "panel.output" },
  { id: "debug", key: "panel.debug" },
  { id: "terminal", key: "panel.terminal" },
  { id: "ports", key: "panel.ports" },
];

const OUTPUT_ROW_HEIGHT = 18;
const OUTPUT_OVERSCAN_ROWS = 12;

type OutputLogRow = {
  id: string;
  kind: "title" | "log";
  level: LspLogLevel;
  text: string;
};

function buildOutputRows(logs: LspLog[], title: string): OutputLogRow[] {
  if (logs.length === 0) return [];

  const rows: OutputLogRow[] = [
    { id: "title", kind: "title", level: "info", text: title },
  ];

  logs.forEach((entry, logIndex) => {
    const time = new Date(entry.time).toLocaleTimeString();
    const source = entry.serverId ? `[${entry.serverId}] ` : "";
    const prefix = `[${time}] ${source}`;
    const continuationPrefix = " ".repeat(prefix.length);

    entry.message.split(/\r?\n/).forEach((line, lineIndex) => {
      rows.push({
        id: `${entry.time}-${logIndex}-${lineIndex}`,
        kind: "log",
        level: entry.level,
        text: `${lineIndex === 0 ? prefix : continuationPrefix}${line}`,
      });
    });
  });

  return rows;
}

function outputRowColor(row: OutputLogRow): string {
  if (row.kind === "title") return "var(--foreground)";
  if (row.level === "error") return "var(--danger)";
  if (row.level === "warning") return "var(--warning)";
  return "var(--muted)";
}

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
  const lspTitle = t("lsp.title");
  const outputRows = useMemo(
    () => buildOutputRows(lspLogs, lspTitle),
    [lspLogs, lspTitle],
  );
  const [outputViewport, setOutputViewport] = useState({
    scrollTop: 0,
    height: 0,
  });

  const syncOutputViewport = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;

    setOutputViewport((prev) => {
      const next = { scrollTop: el.scrollTop, height: el.clientHeight };
      return prev.scrollTop === next.scrollTop && prev.height === next.height
        ? prev
        : next;
    });
  }, []);

  useLayoutEffect(() => {
    if (panelTab !== "output") return;
    syncOutputViewport();

    const el = outputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(syncOutputViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panelTab, syncOutputViewport]);

  useLayoutEffect(() => {
    if (panelTab !== "output") return;
    const el = outputRef.current;
    if (!el) return;

    el.scrollTop = el.scrollHeight;
    syncOutputViewport();
  }, [panelTab, outputRows.length, syncOutputViewport]);

  const outputStartIndex = Math.max(
    0,
    Math.floor(outputViewport.scrollTop / OUTPUT_ROW_HEIGHT) -
      OUTPUT_OVERSCAN_ROWS,
  );
  const outputEndIndex = Math.min(
    outputRows.length,
    Math.ceil(
      (outputViewport.scrollTop + outputViewport.height) / OUTPUT_ROW_HEIGHT,
    ) + OUTPUT_OVERSCAN_ROWS,
  );
  const visibleOutputRows = outputRows.slice(outputStartIndex, outputEndIndex);
  const outputTotalHeight = outputRows.length * OUTPUT_ROW_HEIGHT;

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
          <div ref={outputRef} className="output-log" onScroll={syncOutputViewport}>
            {lspLogs.length === 0 ? (
              <div className="output-empty">{t("panel.noOutput")}</div>
            ) : (
              <div
                className="output-log-spacer"
                style={{ height: outputTotalHeight }}
              >
                <div
                  className="output-log-window"
                  style={{
                    transform: `translateY(${outputStartIndex * OUTPUT_ROW_HEIGHT}px)`,
                  }}
                >
                  {visibleOutputRows.map((row) => (
                    <div
                      key={row.id}
                      className={`output-log-row ${
                        row.kind === "title" ? "output-log-title" : ""
                      }`}
                      style={{ color: outputRowColor(row) }}
                    >
                      {row.text}
                    </div>
                  ))}
                </div>
              </div>
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
