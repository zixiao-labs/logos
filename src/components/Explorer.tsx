import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename, dirname } from "../lib/language";
import type { FileEntry } from "../shared/types";
import { Icon } from "./Icon";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  prepareUserResourceOperation,
  reopenUserResourceOperation,
} from "../lib/lsp-monaco";

interface EditState {
  parent: string;
  kind: "file" | "dir";
  mode: "create" | "rename";
  target?: string;
  value: string;
}

export function Explorer() {
  const t = useT();
  const root = useStore((s) => s.root);
  const workspaceFolders = useStore((s) => s.workspaceFolders);
  const openFile = useStore((s) => s.openFile);
  const openFolder = useStore((s) => s.openFolder);
  const addWorkspaceFolder = useStore((s) => s.addWorkspaceFolder);
  const removeWorkspaceFolder = useStore((s) => s.removeWorkspaceFolder);
  const gitRepositories = useStore((s) => s.gitRepositories);
  const refreshGit = useStore((s) => s.refreshGit);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(
    null,
  );

  const gitMap: Record<string, string> = {};
  for (const [repositoryRoot, repository] of Object.entries(gitRepositories)) {
    for (const c of repository.status.changes) {
      const status = c.working !== " " ? c.working : c.index;
      gitMap[`${repositoryRoot}/${c.path}`.replace(/\\/g, "/")] = status;
    }
  }

  const loadChildren = useCallback(async (dir: string) => {
    const listing = await window.logos.fs.readDir(dir);
    setChildren((c) => ({ ...c, [dir]: listing.entries }));
    return listing.entries;
  }, []);

  // (Re)load every root whenever the workspace changes, and watch all of them.
  useEffect(() => {
    if (workspaceFolders.length === 0) {
      setChildren({});
      setExpanded(new Set());
      return;
    }
    for (const folder of workspaceFolders) {
      void loadChildren(folder);
      void window.logos.fs.watch(folder);
    }
    return () => {
      for (const folder of workspaceFolders) void window.logos.fs.unwatch(folder);
    };
  }, [workspaceFolders, loadChildren]);

  // Refresh open directories (debounced) on file-system changes.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return window.logos.fs.onWatchEvent((e) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        const parent = dirname(e.path);
        const eventRoot = workspaceFolders.find(folder =>
          e.path === folder || e.path.startsWith(`${folder}/`) || e.path.startsWith(`${folder}\\`),
        );
        for (const dir of [eventRoot, parent]) {
          if (dir && (dir === eventRoot || expanded.has(dir))) void loadChildren(dir);
        }
        void refreshGit();
      }, 120);
    });
  }, [workspaceFolders, expanded, loadChildren, refreshGit]);

  async function toggle(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children[dir]) void loadChildren(dir);
      }
      return next;
    });
  }

  function targetDir(): string {
    if (!root) return "";
    if (selected) {
      const sel = selected;
      const isDir = expanded.has(sel) || childIsDir(sel);
      return isDir ? sel : dirname(sel);
    }
    return root;
  }

  function childIsDir(path: string): boolean {
    for (const entries of Object.values(children)) {
      const found = entries.find((e) => e.path === path);
      if (found) return found.type === "directory";
    }
    return false;
  }

  function startCreate(kind: "file" | "dir") {
    const parent = targetDir();
    if (!parent) return;
    if (!expanded.has(parent) && !workspaceFolders.includes(parent)) void toggle(parent);
    setExpanded((p) => new Set(p).add(parent));
    setEdit({ parent, kind, mode: "create", value: "" });
  }

  async function commitEdit() {
    if (!edit || !edit.value.trim()) {
      setEdit(null);
      return;
    }
    const name = edit.value.trim();
    try {
      if (edit.mode === "create") {
        const full = `${edit.parent}/${name}`;
        if (edit.kind === "dir") await window.logos.fs.createDir(full);
        else {
          await window.logos.fs.createFile(full);
          openFile(full);
        }
        await loadChildren(edit.parent);
      } else if (edit.mode === "rename" && edit.target) {
        const dest = `${dirname(edit.target)}/${name}`;
        const reopened = await prepareUserResourceOperation(edit.target);
        try {
          await window.logos.fs.rename(edit.target, dest);
          reopenUserResourceOperation(dest, reopened);
        } catch (error) {
          reopenUserResourceOperation(edit.target, reopened);
          throw error;
        }
        await loadChildren(dirname(edit.target));
      }
    } catch {
      /* surfaced via fs errors; keep UI responsive */
    }
    setEdit(null);
  }

  function openMenu(e: React.MouseEvent, entry?: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    if (entry) setSelected(entry.path);
    const items: MenuItem[] = [
      {
        label: t("explorer.newFile"),
        icon: "new-file",
        onClick: () => startCreate("file"),
      },
      {
        label: t("explorer.newFolder"),
        icon: "new-folder",
        onClick: () => startCreate("dir"),
      },
    ];
    if (entry) {
      items.push(
        { separator: true, label: "", onClick: () => {} },
        {
          label: t("explorer.rename"),
          icon: "edit",
          onClick: () =>
            setEdit({
              parent: dirname(entry.path),
              kind: entry.type === "directory" ? "dir" : "file",
              mode: "rename",
              target: entry.path,
              value: entry.name,
            }),
        },
        {
          label: t("explorer.delete"),
          icon: "trash",
          danger: true,
          onClick: async () => {
            const reopened = await prepareUserResourceOperation(entry.path);
            try {
              await window.logos.fs.delete(entry.path);
            } catch (error) {
              reopenUserResourceOperation(entry.path, reopened);
              throw error;
            }
            await loadChildren(dirname(entry.path));
          },
        },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  if (!root) {
    return (
      <div className="sidepanel" style={{ width: "100%" }}>
        <div className="panel-header">{t("activity.explorer")}</div>
        <div className="empty-state">
          {t("explorer.noFolder")}
          <button className="btn" onClick={openFolder}>
            {t("explorer.openFolder")}
          </button>
        </div>
      </div>
    );
  }

  const renderEditRow = (depth: number) =>
    edit && (
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="tree-twisty" />
        <span className="tree-icon">
          <Icon name={edit.kind === "dir" ? "folder" : "file"} size={15} />
        </span>
        <input
          autoFocus
          className="field"
          style={{ height: 20, padding: "0 4px" }}
          value={edit.value}
          onChange={(ev) => setEdit({ ...edit, value: ev.target.value })}
          onBlur={commitEdit}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") void commitEdit();
            if (ev.key === "Escape") setEdit(null);
          }}
        />
      </div>
    );

  const renderNode = (entry: FileEntry, depth: number): React.ReactNode => {
    const isDir = entry.type === "directory";
    const isOpen = expanded.has(entry.path);
    const status = gitMap[entry.path.replace(/\\/g, "/")];
    return (
      <div key={entry.path}>
        <div
          className={`tree-row ${selected === entry.path ? "selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            setSelected(entry.path);
            if (isDir) void toggle(entry.path);
            else openFile(entry.path);
          }}
          onContextMenu={(e) => openMenu(e, entry)}
        >
          <span className="tree-twisty">
            {isDir && <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={14} />}
          </span>
          <span className="tree-icon">
            <Icon
              name={isDir ? (isOpen ? "folder-open" : "folder") : "file"}
              size={15}
            />
          </span>
          <span
            className="tree-label"
            style={status ? { color: gitColor(status) } : undefined}
          >
            {entry.name}
          </span>
          {status && (
            <span className="git-badge" style={{ color: gitColor(status) }}>
              {status === "?" ? "U" : status.toUpperCase()}
            </span>
          )}
        </div>
        {isDir && isOpen && (
          <div>
            {edit?.parent === entry.path && edit.mode === "create"
              ? renderEditRow(depth + 1)
              : null}
            {(children[entry.path] ?? []).map((c) =>
              edit?.mode === "rename" && edit.target === c.path
                ? renderEditRow(depth + 1)
                : renderNode(c, depth + 1),
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="sidepanel" style={{ width: "100%" }} onClick={() => setSelected(null)}>
      <div className="panel-header">
        <span style={{ fontWeight: 700, color: "var(--foreground)" }}>
          {(workspaceFolders.length > 1
            ? t("explorer.workspace")
            : basename(root)
          ).toUpperCase()}
        </span>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title={t("explorer.newFile")} onClick={() => startCreate("file")}>
            <Icon name="new-file" />
          </button>
          <button className="icon-btn" title={t("explorer.newFolder")} onClick={() => startCreate("dir")}>
            <Icon name="new-folder" />
          </button>
          <button
            className="icon-btn"
            title={t("explorer.addFolder")}
            onClick={() => void addWorkspaceFolder()}
          >
            <Icon name="add" />
          </button>
          <button
            className="icon-btn"
            title={t("explorer.refresh")}
            onClick={() => {
              for (const folder of workspaceFolders) void loadChildren(folder);
              for (const d of expanded) void loadChildren(d);
            }}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="scroll-y" onContextMenu={(e) => openMenu(e)}>
        <div className="tree">
          {workspaceFolders.map(folder => (
            <div key={folder} className="workspace-folder">
              <div className="tree-row workspace-folder-row" title={folder}>
                <span className="tree-twisty">
                  <Icon name="chevron-down" size={14} />
                </span>
                <span className="tree-icon">
                  <Icon name="folder-open" size={15} />
                </span>
                <span className="tree-label" style={{ fontWeight: 650 }}>
                  {basename(folder)}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="icon-btn"
                  title={t("explorer.removeFolder")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeWorkspaceFolder(folder);
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              {edit?.parent === folder && edit.mode === "create" ? renderEditRow(1) : null}
              {(children[folder] ?? []).map((child) =>
                edit?.mode === "rename" && edit.target === child.path
                  ? renderEditRow(1)
                  : renderNode(child, 1),
              )}
            </div>
          ))}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function gitColor(status: string): string {
  switch (status) {
    case "M":
      return "var(--warning)";
    case "?":
    case "A":
      return "var(--success)";
    case "D":
      return "var(--danger)";
    default:
      return "var(--accent)";
  }
}
