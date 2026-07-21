import { useStore } from "../state/store";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import {
  closeTabSafely,
  MonacoEditor,
  reloadFileFromDisk,
} from "./MonacoEditor";
import { SettingsView } from "./SettingsView";
import { ExtensionsView } from "./ExtensionsView";
import { MarkdownPreview } from "./MarkdownPreview";
import { Welcome } from "./Welcome";
import { GitDiffEditor } from "./GitDiffEditor";

export function EditorArea() {
  const t = useT();
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const root = useStore((s) => s.root);
  const workspaceFolders = useStore((s) => s.workspaceFolders);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const openPreview = useStore((s) => s.openPreview);

  const active = tabs.find((tb) => tb.id === activeTabId) ?? null;

  async function close(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await closeTabSafely(id);
  }

  async function reloadActiveFile(tabId: string, path: string) {
    try {
      await reloadFileFromDisk(path);
    } catch {
      const exists = await window.logos.fs.exists(path).catch(() => true);
      if (exists) return;
      useStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === tabId && tab.kind === "file" && tab.path === path
            ? { ...tab, externalChange: "deleted" }
            : tab,
        ),
      }));
    }
  }

  const activeWorkspaceRoot =
    active?.kind === "file" && active.path
      ? (workspaceFolders.find(
          (folder) =>
            active.path === folder ||
            active.path!.startsWith(`${folder}/`) ||
            active.path!.startsWith(`${folder}\\`),
        ) ?? root)
      : null;
  const crumbs =
    active?.kind === "file" && active.path
      ? (activeWorkspaceRoot
          ? active.path
              .slice(activeWorkspaceRoot.length)
              .replace(/^[\\/]/, "")
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
                      : tab.kind === "diff"
                          ? "git"
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
          {active.externalChange && active.path && (
            <button
              className="external-change"
              title={t(`editor.external.${active.externalChange}`)}
              disabled={active.externalChange === "deleted"}
              onClick={() => void reloadActiveFile(active.id, active.path!)}
            >
              <Icon name="warning" size={12} />
              {t(`editor.external.${active.externalChange}`)}
            </button>
          )}
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
        {(active?.kind === "file" || active?.kind === "debug-source") &&
          active.path && (
          <MonacoEditor
            key={active.path}
            path={active.path}
            language={active.language ?? "plaintext"}
            content={active.content}
            readOnly={active.content !== undefined}
            debugPosition={active.debugPosition}
          />
          )}
        {active?.kind === "welcome" && <Welcome />}
        {active?.kind === "diff" && active.diff && (
          <GitDiffEditor
            root={active.diff.root}
            path={active.diff.path}
            staged={active.diff.staged}
            language={active.language ?? "plaintext"}
          />
        )}
        {active?.kind === "settings" && <SettingsView />}
        {active?.kind === "extensions" && <ExtensionsView />}
        {active?.kind === "preview" && active.path && (
          <MarkdownPreview path={active.path} />
        )}
        {!active && <div className="welcome">{t("editor.noTabs")}</div>}
      </div>
    </div>
  );
}
