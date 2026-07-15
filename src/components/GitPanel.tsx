import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename, dirname } from "../lib/language";
import { notify, notifyError, notifySuccess } from "../lib/toast";
import type { GitFileChange } from "../shared/types";
import { Icon } from "./Icon";

export function GitPanel() {
  const t = useT();
  const root = useStore((s) => s.root);
  const git = useStore((s) => s.git);
  const gitHead = useStore((s) => s.gitHead);
  const refreshGit = useStore((s) => s.refreshGit);
  const gitFetch = useStore((s) => s.gitFetch);
  const gitPull = useStore((s) => s.gitPull);
  const gitPush = useStore((s) => s.gitPush);
  const gitSync = useStore((s) => s.gitSync);
  const openGitDiff = useStore((s) => s.openGitDiff);
  const [message, setMessage] = useState("");

  async function run(fn: () => Promise<unknown>) {
    await fn();
    await refreshGit();
  }

  const staged = git?.changes.filter((change) => change.index !== " ") ?? [];
  const unstaged =
    git?.changes.filter((change) => change.working !== " ") ?? [];

  // F4: commit must not silently no-op. Disable when there's nothing to commit,
  // and stage-all-then-commit when changes exist but nothing is staged yet.
  const canCommit =
    message.trim().length > 0 && (staged.length > 0 || unstaged.length > 0);

  async function commit(push = false) {
    if (!root) return;
    // Paths that bypass the disabled buttons (header icon, ⌘Enter, native menu)
    // can reach here with nothing to commit — give feedback instead of no-op'ing.
    if (!canCommit) {
      notify(t("git.nothingToCommit"));
      return;
    }
    try {
      if (staged.length === 0 && unstaged.length > 0) {
        await window.logos.git.stage(
          root,
          unstaged.map((c) => c.path),
        );
      }
      await window.logos.git.commit(root, message);
      setMessage("");
      notifySuccess(t("git.committed"));
      await refreshGit();
      if (push) await gitPush(); // store action toasts the push result
    } catch (e) {
      notifyError(t("git.commitFailed"), (e as Error).message);
    }
  }

  async function amend() {
    if (!root || !gitHead) return;
    try {
      await window.logos.git.commitAmend(root, message.trim());
      setMessage("");
      notifySuccess(t("git.amended"));
      await refreshGit();
    } catch (e) {
      notifyError(t("git.commitFailed"), (e as Error).message);
    }
  }

  async function undoLast() {
    if (!root || !gitHead) return;
    try {
      await window.logos.git.undoLastCommit(root);
      notify(t("git.undone"));
      await refreshGit();
    } catch (e) {
      notifyError(t("git.commitFailed"), (e as Error).message);
    }
  }

  // Native menu "Git → Commit" dispatches this event; commit the current message.
  // A ref keeps the listener stable while still committing with the latest state.
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => void commit();
  useEffect(() => {
    const h = () => commitRef.current();
    window.addEventListener("logos:menu:git-commit", h);
    return () => window.removeEventListener("logos:menu:git-commit", h);
  }, []);

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

  const FileRow = ({
    change,
    actions,
    staged,
  }: {
    change: GitFileChange;
    staged: boolean;
    actions: { icon: import("./Icon").IconName; title: string; onClick: () => void }[];
  }) => {
    const status = staged ? change.index : change.working;
    return (
      <div className="tree-row" onClick={() => openGitDiff(change.path, staged)}>
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
            onClick={() => void commit()}
          >
            <Icon name="check" />
          </button>
          <button className="icon-btn" title={t("git.fetch")} onClick={() => void gitFetch()}>
            <Icon name="globe" />
          </button>
          <button className="icon-btn" title={t("git.pull")} onClick={() => void gitPull()}>
            <Icon name="download" />
          </button>
          <button className="icon-btn" title={t("git.push")} onClick={() => void gitPush()}>
            <Icon name="upload" />
          </button>
          <button className="icon-btn" title={t("git.sync")} onClick={() => void gitSync()}>
            <Icon name="refresh" />
          </button>
          <button className="icon-btn" title={t("explorer.refresh")} onClick={() => void refreshGit()}>
            <Icon name="more" />
          </button>
        </div>
      </div>

      {gitHead && (
        <div
          className="tree-row"
          style={{ alignItems: "center", gap: 6, opacity: 0.9 }}
          title={`${gitHead.shortHash} · ${gitHead.author} · ${gitHead.date}`}
        >
          <span className="tree-icon">
            <Icon name="branch" size={13} />
          </span>
          <span style={{ color: "var(--muted)", fontSize: 11, fontFamily: "var(--mono-font)" }}>
            {gitHead.shortHash}
          </span>
          <span
            className="tree-label"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {gitHead.message}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            title={t("git.undoCommit")}
            onClick={(e) => {
              e.stopPropagation();
              void undoLast();
            }}
          >
            <Icon name="discard" size={14} />
          </button>
        </div>
      )}

      <div style={{ padding: "8px 12px" }}>
        <textarea
          className="field"
          rows={2}
          placeholder={t("git.message")}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              void commit();
            }
          }}
        />
        <button
          className="btn"
          style={{ marginTop: 6 }}
          disabled={!canCommit}
          title={canCommit ? "" : t("git.nothingToCommit")}
          onClick={() => void commit()}
        >
          <Icon name="check" /> {t("git.commit")}
          {staged.length > 0 ? ` (${staged.length})` : ""}
        </button>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button
            className="btn"
            style={{ flex: 1 }}
            disabled={!canCommit}
            title={canCommit ? t("git.commitAndPush") : t("git.nothingToCommit")}
            onClick={() => void commit(true)}
          >
            <Icon name="upload" size={14} /> {t("git.commitAndPush")}
          </button>
          <button
            className="btn"
            style={{ flex: 1 }}
            disabled={!gitHead}
            title={t("git.amend")}
            onClick={() => void amend()}
          >
            <Icon name="edit" size={14} /> {t("git.amend")}
          </button>
        </div>
      </div>

      <div className="scroll-y">
        {git?.clean && (
          <div className="empty-state">{t("git.clean")}</div>
        )}
        {staged.length > 0 && (
          <>
            <div className="panel-header" style={{ height: 28 }}>
              <span>{t("git.stagedChanges")}</span>
              <div className="actions">
                <button
                  className="icon-btn"
                  title={t("git.unstageAll")}
                  onClick={() =>
                    void run(() =>
                      window.logos.git.unstage(
                        root,
                        staged.map((c) => c.path),
                      ),
                    )
                  }
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
            {staged.map((c) => (
              <FileRow
                key={c.path}
                change={c}
                staged
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
                staged={false}
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
