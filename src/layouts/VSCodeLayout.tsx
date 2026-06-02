import { useStore } from "../state/store";
import { ActivityBar } from "../components/ActivityBar";
import { SideContent } from "../components/SideContent";
import { AgentPanel } from "../components/AgentPanel";
import { Resizer } from "../components/Resizer";
import { CenterColumn } from "./CenterColumn";

/**
 * Standard VS Code arrangement:
 * [Activity Bar][Primary Side Bar][Editor + Panel][Secondary Side Bar = Agent]
 */
export function VSCodeLayout() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const sidebarView = useStore((s) => s.sidebarView);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const secondaryVisible = useStore((s) => s.secondaryVisible);
  const secondaryWidth = useStore((s) => s.secondaryWidth);
  const toggleSecondary = useStore((s) => s.toggleSecondary);

  return (
    <div className="workbench-body">
      <ActivityBar />

      {sidebarVisible && (
        <>
          <div style={{ width: sidebarWidth, display: "flex", minWidth: 0 }}>
            <SideContent view={sidebarView} />
          </div>
          <Resizer
            orientation="vertical"
            onResize={(d) =>
              useStore.getState().setSidebarWidth(
                useStore.getState().sidebarWidth + d,
              )
            }
          />
        </>
      )}

      <CenterColumn />

      {secondaryVisible && (
        <>
          <Resizer
            orientation="vertical"
            onResize={(d) =>
              useStore.getState().setSecondaryWidth(
                useStore.getState().secondaryWidth - d,
              )
            }
          />
          <div className="sidepanel right" style={{ width: secondaryWidth }}>
            <AgentPanel onClose={toggleSecondary} />
          </div>
        </>
      )}
    </div>
  );
}
