import { useStore } from "../state/store";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { closeTabSafely, MonacoEditor } from "./MonacoEditor";
import { SettingsView } from "./SettingsView";
import { ExtensionsView } from "./ExtensionsView";
import { MarkdownPreview } from "./MarkdownPreview";
import { Welcome } from "./Welcome";

export function EditorArea() {
  const t = useT();
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const root = useStore((s) => s.root);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const openPreview = useStore((s) => s.openPreview);

  const active = tabs.find((tb) => tb.id === activeTabId) ?? null;

  async function close(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await closeTabSafely(id);
  }

  const crumbs =
    active?.kind === "file" && active.path
      ? (root && active.path.startsWith(root)
          ? active.path.slice(root.length + 1)
          : active.path
        ).split(/[\\/]/)
      : [];

  return (
    <div className="editor-area">
      <div className="tabbar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) void close(e, tab.id);
            }}
            title={tab.path ?? tab.name}
          >
            <Icon
              name={
                tab.kind === "settings"
                  ? "settings"
                  : tab.kind === "extensions"
                    ? "extensions"
                    : tab.kind === "preview"
                      ? "preview"
                      : tab.kind === "webview"
                        ? "globe"
                        : "file"
              }
              size={14}
            />
            <span className="label">{tab.name}</span>
            {tab.dirty ? (
              <span className="dirty" />
            ) : (
              <span className="close" onClick={(e) => void close(e, tab.id)}>
                <Icon name="close" size={13} />
              </span>
            )}
          </div>
        ))}
      </div>

      {active?.kind === "file" && (
        <div className="breadcrumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {c}
              {i < crumbs.length - 1 && (
                <Icon name="chevron-right" size={12} style={{ margin: "0 2px" }} />
              )}
            </span>
          ))}
          <div style={{ flex: 1 }} />
          {active.language === "markdown" && active.path && (
            <button
              className="icon-btn"
              title={t("editor.preview")}
              onClick={() => openPreview(active.path!)}
            >
              <Icon name="preview" />
            </button>
          )}
        </div>
      )}

      <div className="editor-host">
        {active?.kind === "file" && active.path && (
          <MonacoEditor
            key={active.path}
            path={active.path}
            language={active.language ?? "plaintext"}
          />
        )}
        {active?.kind === "welcome" && <Welcome />}
        {active?.kind === "settings" && <SettingsView />}
        {active?.kind === "extensions" && <ExtensionsView />}
        {active?.kind === "preview" && active.path && (
          <MarkdownPreview path={active.path} />
        )}
        {active?.kind === "webview" && active.url && (
          <webview src={active.url} className="webview-host" />
        )}
        {!active && <div className="welcome">{t("editor.noTabs")}</div>}
      </div>
    </div>
  );
}
