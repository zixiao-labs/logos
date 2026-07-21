import { useState } from "react";
import { useStore, type SidebarView } from "../state/store";
import { useT } from "../i18n";
import { AgentPanel } from "../components/AgentPanel";
import { SideContent } from "../components/SideContent";
import { Resizer } from "../components/Resizer";
import { Icon, type IconName } from "../components/Icon";
import { CenterColumn } from "./CenterColumn";

/**
 * Cursor-style arrangement (see reference screenshot):
 * [Agents rail][Agent chat][Editor + Panel][Explorer on the right]
 */
export function CursorLayout() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const sidebarView = useStore((s) => s.sidebarView);
  const setSidebarView = useStore((s) => s.setSidebarView);
  const secondaryVisible = useStore((s) => s.secondaryVisible);
  const secondaryWidth = useStore((s) => s.secondaryWidth);

  const dockItems: { view: SidebarView; icon: IconName }[] = [
    { view: "explorer", icon: "files" },
    { view: "search", icon: "search" },
    { view: "git", icon: "git" },
    { view: "gitGraph", icon: "graph" },
    { view: "debug", icon: "debug" },
  ];

  return (
    <div className="workbench-body">
      {secondaryVisible && (
        <>
          <AgentsRail />
          <div
            className="sidepanel"
            style={{ width: secondaryWidth, minWidth: 0 }}
          >
            <AgentPanel hideSessions />
          </div>
          <Resizer
            orientation="vertical"
            onResize={(d) =>
              useStore.getState().setSecondaryWidth(
                useStore.getState().secondaryWidth + d,
              )
            }
          />
        </>
      )}

      <CenterColumn />

      {sidebarVisible && (
        <>
          <Resizer
            orientation="vertical"
            onResize={(d) =>
              useStore.getState().setSidebarWidth(
                useStore.getState().sidebarWidth - d,
              )
            }
          />
          <div
            className="sidepanel right"
            style={{ width: sidebarWidth, minWidth: 0 }}
          >
            <div className="panel-header" style={{ gap: 4 }}>
              <div className="actions">
                {dockItems.map((it) => (
                  <button
                    key={it.view}
                    className={`icon-btn ${sidebarView === it.view ? "" : ""}`}
                    style={
                      sidebarView === it.view
                        ? { color: "var(--foreground)", background: "var(--surface-secondary)" }
                        : undefined
                    }
                    onClick={() => setSidebarView(it.view)}
                  >
                    <Icon name={it.icon} />
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <SideContent view={sidebarView} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Narrow agents list shown on the far left in the Cursor layout. */
function AgentsRail() {
  const t = useT();
  const sessions = useStore((s) => s.agentSessions);
  const activeAgentId = useStore((s) => s.activeAgentId);
  const setActiveAgent = useStore((s) => s.setActiveAgent);
  const newAgentSession = useStore((s) => s.newAgentSession);
  const removeAgentSession = useStore((s) => s.removeAgentSession);
  const [query, setQuery] = useState("");

  const filtered = sessions.filter((s) =>
    s.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div
      className="sidepanel"
      style={{ width: 200, minWidth: 200, padding: "10px 8px", gap: 8 }}
    >
      <input
        className="field"
        placeholder={t("agent.searchAgents")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button className="btn secondary" onClick={() => newAgentSession()}>
        <Icon name="add" /> {t("agent.newAgent")}
      </button>
      <div className="scroll-y" style={{ marginTop: 4 }}>
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`agent-tab ${s.id === activeAgentId ? "active" : ""}`}
            style={{ width: "100%", marginBottom: 2 }}
            onClick={() => setActiveAgent(s.id)}
          >
            <Icon name="agent" size={14} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.name}
            </span>
            {s.status === "running" && <span className="dirty" />}
            {s.status === "waiting" && <span className="thread-waiting">?</span>}
            <span
              className="icon-btn"
              style={{ width: 16, height: 16 }}
              onClick={(e) => {
                e.stopPropagation();
                removeAgentSession(s.id);
              }}
            >
              <Icon name="close" size={11} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
