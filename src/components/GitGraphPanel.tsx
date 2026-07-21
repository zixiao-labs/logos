import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { gitGraphColor, layoutGitGraph } from "../lib/git-graph";
import type { GitGraphEntry } from "../shared/types";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

const LANE_WIDTH = 16;
const ROW_HEIGHT = 42;

export function GitGraphPanel() {
  const t = useT();
  const workspaceFolders = useStore(state => state.workspaceFolders);
  const root = useStore(state => state.gitRoot ?? state.root);
  const setGitRoot = useStore(state => state.setGitRoot);
  const [commits, setCommits] = useState<GitGraphEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!root) {
      setCommits([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setCommits(await window.logos.git.graph(root, 300));
    } catch (reason) {
      setCommits([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
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

  const rows = layoutGitGraph(commits);

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
      {workspaceFolders.length > 1 && (
        <div style={{ padding: "6px 8px" }}>
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
        </div>
      )}
      <div className="scroll-y" data-testid="git-graph">
        {loading && commits.length === 0 && <div className="empty-state">{t("git.graphLoading")}</div>}
        {!loading && error && <div className="empty-state">{error}</div>}
        {!loading && !error && commits.length === 0 && (
          <div className="empty-state">{t("git.graphEmpty")}</div>
        )}
        {rows.map(row => {
          const graphWidth = row.laneCount * LANE_WIDTH + 12;
          const x = (lane: number) => 8 + lane * LANE_WIDTH;
          return (
            <div className="git-graph-row" key={row.commit.hash} title={row.commit.hash}>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
