import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { gitGraphColor, layoutGitGraph } from "../lib/git-graph";
import type { GitCommitDetails, GitGraphEntry } from "../shared/types";
import { useStore } from "../state/store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";

const LANE_WIDTH = 16;
const ROW_HEIGHT = 42;
const PAGE_SIZE = 200;

interface CommitMenu {
  x: number;
  y: number;
  commit: GitGraphEntry;
}

function searchableCommit(commit: GitGraphEntry): string {
  return [
    commit.hash,
    commit.message,
    commit.author,
    ...commit.refs,
  ].join("\n").toLocaleLowerCase();
}

export function GitGraphPanel() {
  const t = useT();
  const workspaceFolders = useStore(state => state.workspaceFolders);
  const root = useStore(state => state.gitRoot ?? state.root);
  const setGitRoot = useStore(state => state.setGitRoot);
  const [commits, setCommits] = useState<GitGraphEntry[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [menu, setMenu] = useState<CommitMenu | null>(null);
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsRequest = useRef(0);

  const refresh = useCallback(async () => {
    if (!root) {
      setCommits([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setCommits(await window.logos.git.graph(root, limit));
    } catch (reason) {
      setCommits([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [limit, root]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
    setSelectedHash(null);
    setDetails(null);
    setQuery("");
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => window.logos.git.onChanged(changedRoot => {
      if (changedRoot === root) void refresh();
    }),
    [refresh, root],
  );

  const filteredCommits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? commits.filter(commit => searchableCommit(commit).includes(needle))
      : commits;
  }, [commits, query]);
  const rows = layoutGitGraph(filteredCommits);

  const selectCommit = useCallback(async (commit: GitGraphEntry) => {
    if (!root) return;
    if (selectedHash === commit.hash) {
      detailsRequest.current++;
      setSelectedHash(null);
      setDetails(null);
      setDetailsLoading(false);
      return;
    }
    const request = ++detailsRequest.current;
    setSelectedHash(commit.hash);
    setDetails(null);
    setDetailsLoading(true);
    setError(null);
    try {
      const value = await window.logos.git.commitDetails(root, commit.hash);
      if (detailsRequest.current === request) setDetails(value);
    } catch (reason) {
      if (detailsRequest.current === request) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (detailsRequest.current === request) setDetailsLoading(false);
    }
  }, [root, selectedHash]);

  const runCommitAction = useCallback(async (
    commit: GitGraphEntry,
    action: () => Promise<void>,
  ) => {
    setBusyHash(commit.hash);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyHash(null);
    }
  }, [refresh]);

  const commitMenuItems = useCallback((commit: GitGraphEntry): MenuItem[] => {
    if (!root) return [];
    return [
      {
        label: t("git.graph.copyHash"),
        icon: "commit",
        onClick: () => void navigator.clipboard.writeText(commit.hash),
      },
      {
        label: t("git.graph.createBranch"),
        icon: "branch",
        onClick: () => {
          const name = window.prompt(t("git.graph.branchName"));
          if (name?.trim()) {
            void runCommitAction(commit, () =>
              window.logos.git.createBranch(root, name.trim(), commit.hash));
          }
        },
      },
      {
        label: t("git.graph.checkout"),
        icon: "git",
        onClick: () => {
          if (window.confirm(t("git.graph.checkoutConfirm"))) {
            void runCommitAction(commit, () => window.logos.git.checkout(root, commit.hash));
          }
        },
      },
      {
        label: t("git.graph.cherryPick"),
        icon: "download",
        onClick: () => {
          if (window.confirm(t("git.graph.cherryPickConfirm"))) {
            void runCommitAction(commit, () => window.logos.git.cherryPick(root, commit.hash));
          }
        },
      },
      {
        label: t("git.graph.revert"),
        icon: "discard",
        danger: true,
        onClick: () => {
          if (window.confirm(t("git.graph.revertConfirm"))) {
            void runCommitAction(commit, () => window.logos.git.revert(root, commit.hash));
          }
        },
      },
    ];
  }, [root, runCommitAction, t]);

  const moveSelection = (currentIndex: number, offset: number) => {
    const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + offset));
    const next = rows[nextIndex]?.commit;
    if (!next) return;
    document.querySelector<HTMLElement>(`[data-git-commit="${next.hash}"]`)?.focus();
  };

  return (
    <div className="sidepanel git-graph-panel" style={{ width: "100%" }}>
      <div className="panel-header">
        <span style={{ fontWeight: 700, color: "var(--foreground)" }}>
          {t("git.graph").toUpperCase()}
        </span>
        <button className="icon-btn" title={t("explorer.refresh")} onClick={() => void refresh()}>
          <Icon name="refresh" />
        </button>
      </div>
      <div className="git-graph-controls">
        {workspaceFolders.length > 1 && (
          <select
            className="field git-repository-select"
            aria-label={t("git.repository")}
            value={root ?? ""}
            onChange={event => setGitRoot(event.target.value)}
          >
            {workspaceFolders.map(folder => (
              <option key={folder} value={folder}>{basename(folder)}</option>
            ))}
          </select>
        )}
        <label className="git-graph-search">
          <Icon name="search" size={13} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("git.graph.search")}
            aria-label={t("git.graph.search")}
          />
          {query && (
            <button className="icon-btn" title={t("git.graph.clearSearch")} onClick={() => setQuery("")}>
              <Icon name="close" size={12} />
            </button>
          )}
        </label>
      </div>
      {error && <div className="git-graph-error" role="alert">{error}</div>}
      <div className="scroll-y" data-testid="git-graph">
        {loading && commits.length === 0 && <div className="empty-state">{t("git.graphLoading")}</div>}
        {!loading && !error && commits.length === 0 && (
          <div className="empty-state">{t("git.graphEmpty")}</div>
        )}
        {!loading && commits.length > 0 && rows.length === 0 && (
          <div className="empty-state">{t("git.graph.noMatches")}</div>
        )}
        {rows.map((row, rowIndex) => {
          const graphWidth = row.laneCount * LANE_WIDTH + 12;
          const x = (lane: number) => 8 + lane * LANE_WIDTH;
          const selected = row.commit.hash === selectedHash;
          return (
            <Fragment key={row.commit.hash}>
              <div
                className={`git-graph-row${selected ? " selected" : ""}`}
                title={row.commit.hash}
                data-git-commit={row.commit.hash}
                role="button"
                tabIndex={0}
                aria-expanded={selected}
                aria-busy={busyHash === row.commit.hash}
                onClick={() => void selectCommit(row.commit)}
                onContextMenu={event => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, commit: row.commit });
                }}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void selectCommit(row.commit);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveSelection(rowIndex, 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveSelection(rowIndex, -1);
                  }
                }}
              >
                <svg width={graphWidth} height={ROW_HEIGHT} aria-hidden>
                  {row.incoming.map(incoming => (
                    <path
                      key={`incoming:${incoming.hash}`}
                      d={`M ${x(incoming.lane)} 0 L ${x(incoming.lane)} ${ROW_HEIGHT / 2}`}
                      fill="none"
                      stroke={gitGraphColor(incoming.hash)}
                      strokeWidth="2"
                    />
                  ))}
                  {row.edges.map((edge, index) => (
                    <path
                      key={`${edge.hash}:${index}`}
                      d={`M ${x(edge.from)} ${ROW_HEIGHT / 2} C ${x(edge.from)} ${ROW_HEIGHT * 0.75}, ${x(edge.to)} ${ROW_HEIGHT * 0.75}, ${x(edge.to)} ${ROW_HEIGHT}`}
                      fill="none"
                      stroke={gitGraphColor(edge.hash)}
                      strokeWidth="2"
                    />
                  ))}
                  <circle
                    cx={x(row.lane)}
                    cy={ROW_HEIGHT / 2}
                    r="4"
                    fill="var(--background)"
                    stroke={gitGraphColor(row.commit.hash)}
                    strokeWidth="2.5"
                  />
                </svg>
                <div className="git-graph-commit">
                  <div className="git-graph-subject">
                    <span>{row.commit.message}</span>
                    {row.commit.refs.map(ref => <span className="git-ref" key={ref}>{ref}</span>)}
                  </div>
                  <div className="git-graph-meta">
                    <code>{row.commit.shortHash}</code>
                    <span>{row.commit.author}</span>
                    <time dateTime={row.commit.date}>{new Date(row.commit.date).toLocaleString()}</time>
                  </div>
                </div>
                <button
                  className="icon-btn git-graph-more"
                  title={t("git.graph.actions")}
                  aria-label={t("git.graph.actions")}
                  onClick={event => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.right, y: rect.bottom, commit: row.commit });
                  }}
                >
                  <Icon name="more" size={14} />
                </button>
              </div>
              {selected && (
                <section className="git-commit-details" data-testid="git-commit-details">
                  {detailsLoading && <div className="empty-state">{t("git.graph.detailsLoading")}</div>}
                  {details && (
                    <>
                      {details.body && details.body !== details.message && (
                        <pre>{details.body}</pre>
                      )}
                      <div className="git-commit-identity">
                        <span>{details.author} &lt;{details.authorEmail}&gt;</span>
                        <time dateTime={details.date}>{new Date(details.date).toLocaleString()}</time>
                      </div>
                      <div className="git-commit-files">
                        {details.files.map(file => (
                          <div className="git-commit-file" key={file.path} title={file.path}>
                            <span>{file.path}</span>
                            {file.binary ? (
                              <code>binary</code>
                            ) : (
                              <code><b>+{file.additions}</b> <i>-{file.deletions}</i></code>
                            )}
                          </div>
                        ))}
                        {details.files.length === 0 && (
                          <span className="muted">{t("git.graph.noFiles")}</span>
                        )}
                      </div>
                    </>
                  )}
                </section>
              )}
            </Fragment>
          );
        })}
        {!query && commits.length >= limit && (
          <button
            className="git-graph-load-more"
            disabled={loading}
            onClick={() => setLimit(current => current + PAGE_SIZE)}
          >
            {loading ? t("git.graphLoading") : t("git.graph.loadMore")}
          </button>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={commitMenuItems(menu.commit)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
