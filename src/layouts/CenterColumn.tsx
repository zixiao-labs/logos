import { useStore } from "../state/store";
import { EditorArea } from "../components/EditorArea";
import { Panel } from "../components/Panel";
import { Resizer } from "../components/Resizer";

/** Editor area with an optional resizable bottom panel. Shared by both layouts. */
export function CenterColumn() {
  const panelVisible = useStore((s) => s.panelVisible);
  const panelHeight = useStore((s) => s.panelHeight);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <EditorArea />
      </div>
      {panelVisible && (
        <>
          <Resizer
            orientation="horizontal"
            onResize={(d) =>
              useStore.getState().setPanelHeight(
                useStore.getState().panelHeight - d,
              )
            }
          />
          <div style={{ height: panelHeight, minHeight: 0, overflow: "hidden" }}>
            <Panel />
          </div>
        </>
      )}
    </div>
  );
}
