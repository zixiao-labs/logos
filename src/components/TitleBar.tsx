import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { Icon } from "./Icon";

const isMac = navigator.platform.toLowerCase().includes("mac");

export function TitleBar() {
  const t = useT();
  const layout = useStore((s) => s.settings["workbench.layout"]);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const secondaryVisible = useStore((s) => s.secondaryVisible);
  const panelVisible = useStore((s) => s.panelVisible);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleSecondary = useStore((s) => s.toggleSecondary);
  const togglePanel = useStore((s) => s.togglePanel);
  const toggleLayout = useStore((s) => s.toggleLayout);
  const openSpecial = useStore((s) => s.openSpecial);
  const root = useStore((s) => s.root);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => window.logos.app.onWindowState((s) => setMaximized(s.maximized)), []);

  const title = root ? root.split(/[\\/]/).pop() : "Logos";

  return (
    <div className="titlebar">
      <div className="titlebar-left" />
      <div className="spacer" />
      <div className="titlebar-center">{title}</div>
      <div className="spacer" />
      <div className="titlebar-actions">
        <button
          className={`titlebar-btn ${sidebarVisible ? "active" : ""}`}
          title="Toggle Primary Side Bar"
          onClick={toggleSidebar}
        >
          <Icon name="sidebar-left" />
        </button>
        <button
          className={`titlebar-btn ${panelVisible ? "active" : ""}`}
          title="Toggle Panel"
          onClick={togglePanel}
        >
          <Icon name="panel-bottom" />
        </button>
        <button
          className={`titlebar-btn ${secondaryVisible ? "active" : ""}`}
          title="Toggle Secondary Side Bar"
          onClick={toggleSecondary}
        >
          <Icon name="sidebar-right" />
        </button>
        <button
          className="titlebar-btn"
          title={
            layout === "vscode"
              ? t("status.layout.cursor")
              : t("status.layout.vscode")
          }
          onClick={toggleLayout}
        >
          <Icon name="layout" />
        </button>
        <button
          className="titlebar-btn"
          title={t("activity.settings")}
          onClick={() => openSpecial("settings")}
        >
          <Icon name="settings" />
        </button>

        {!isMac && (
          <>
            <button
              className="titlebar-btn"
              onClick={() => window.logos.app.windowControl("minimize")}
            >
              <Icon name="win-min" size={14} />
            </button>
            <button
              className="titlebar-btn"
              onClick={() =>
                window.logos.app.windowControl(
                  maximized ? "unmaximize" : "maximize",
                )
              }
            >
              <Icon name="win-max" size={12} />
            </button>
            <button
              className="titlebar-btn"
              onClick={() => window.logos.app.windowControl("close")}
            >
              <Icon name="win-close" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
