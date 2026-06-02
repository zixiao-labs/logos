import { useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename, dirname } from "../lib/language";
import type { GitFileChange } from "../shared/types";
import { Icon } from "./Icon";

export function GitPanel() {
  const t = useT();
  const root = useStore((s) => s.root);
  const git = useStore((s) => s.git);
  const refreshGit = useStore((s) => s.refreshGit);
  const openFile = useStore((s) => s.openFile);
  const [message, setMessage] = useState("");

  async function run(fn: () => Promise<unknown>) {
    await fn();
    await refreshGit();
  }

  if (!root) {
    return (
      <div className="sidepanel" style={{ width: "100%" }}>
        <div className="panel-header">{t("git.title")}</div>
        <div className="empty-state">{t("explorer.noFolder")}</div>
      </div>
    );
  }

  if (git && !git.isRepo) {
    return (
      <div className="sidepanel" style={{ width: "100%" }}>
        <div className="panel-header">{t("git.title")}</div>
        <div className="empty-state">
          {t("git.notRepo")}
          <button
            className="btn"
            onClick={() => void run(() => window.logos.git.init(root))}
          >
            {t("git.init")}
          </button>
        </div>
      </div>
    );
  }

  const staged = git?.changes.filter((c) => c.staged) ?? [];
  const unstaged = git?.changes.filter((c) => !c.staged) ?? [];

  const FileRow = ({
    change,
    actions,
  }: {
    change: GitFileChange;
    actions: { icon: import("./Icon").IconName; title: string; onClick: () => void }[];
  }) => {
    const status = change.working !== " " ? change.working : change.index;
    return (
      <div className="tree-row" onClick={() => openFile(`${root}/${change.path}`)}>
        <span className="tree-icon">
          <Icon name="file" size={14} />
        </span>
        <span className="tree-label">{basename(change.path)}</span>
        <span className="path" style={{ color: "var(--muted)", fontSize: 11, marginLeft: 6 }}>
          {dirname(change.path)}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="actions"
          style={{ display: "flex", gap: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          {actions.map((a) => (
            <button key={a.title} className="icon-btn" title={a.title} onClick={a.onClick}>
              <Icon name={a.icon} size={14} />
            </button>
          ))}
        </span>
        <span
          style={{
            width: 16,
            textAlign: "center",
            color: "var(--warning)",
            fontWeight: 600,
          }}
        >
          {status === "?" ? "U" : status}
        </span>
      </div>
    );
  };

  return (
    <div className="sidepanel" style={{ width: "100%" }}>
      <div className="panel-header">
        <span style={{ fontWeight: 700, color: "var(--foreground)" }}>
          {t("git.title").toUpperCase()}
        </span>
        <div className="actions">
          <button
            className="icon-btn"
            title={t("git.commit")}
            onClick={() =>
              message.trim() &&
              void run(async () => {
                await window.logos.git.commit(root, message);
                setMessage("");
              })
            }
          >
            <Icon name="check" />
          </button>
          <button className="icon-btn" title={t("git.pull")} onClick={() => void run(() => window.logos.git.pull(root))}>
            <Icon name="refresh" />
          </button>
          <button className="icon-btn" title={t("explorer.refresh")} onClick={() => void refreshGit()}>
            <Icon name="refresh" />
          </button>
        </div>
      </div>

      <div style={{ padding: "8px 12px" }}>
        <textarea
          className="field"
          rows={2}
          placeholder={t("git.message")}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && message.trim()) {
              void run(async () => {
                await window.logos.git.commit(root, message);
                setMessage("");
              });
            }
          }}
        />
        <button
          className="btn"
          style={{ marginTop: 6 }}
          disabled={!message.trim()}
          onClick={() =>
            void run(async () => {
              await window.logos.git.commit(root, message);
              setMessage("");
            })
          }
        >
          <Icon name="check" /> {t("git.commit")}
          {staged.length > 0 ? ` (${staged.length})` : ""}
        </button>
      </div>

      <div className="scroll-y">
        {git?.clean && (
          <div className="empty-state">{t("git.clean")}</div>
        )}
        {staged.length > 0 && (
          <>
            <div className="panel-header" style={{ height: 28 }}>
              <span>{t("git.stagedChanges")}</span>
              <span style={{ color: "var(--muted)" }}>{staged.length}</span>
            </div>
            {staged.map((c) => (
              <FileRow
                key={c.path}
                change={c}
                actions={[
                  {
                    icon: "close",
                    title: t("git.unstage"),
                    onClick: () =>
                      void run(() => window.logos.git.unstage(root, [c.path])),
                  },
                ]}
              />
            ))}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <div className="panel-header" style={{ height: 28 }}>
              <span>{t("git.changes")}</span>
              <div className="actions">
                <button
                  className="icon-btn"
                  title={t("git.stageAll")}
                  onClick={() =>
                    void run(() =>
                      window.logos.git.stage(
                        root,
                        unstaged.map((c) => c.path),
                      ),
                    )
                  }
                >
                  <Icon name="add" />
                </button>
              </div>
            </div>
            {unstaged.map((c) => (
              <FileRow
                key={c.path}
                change={c}
                actions={[
                  {
                    icon: "discard",
                    title: t("git.discard"),
                    onClick: () =>
                      void run(() => window.logos.git.discard(root, [c.path])),
                  },
                  {
                    icon: "add",
                    title: t("git.stage"),
                    onClick: () =>
                      void run(() => window.logos.git.stage(root, [c.path])),
                  },
                ]}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
