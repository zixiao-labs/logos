import type { GitGraphEntry } from "../shared/types";

export interface GitGraphEdge {
  from: number;
  to: number;
  hash: string;
}

export interface GitGraphRow {
  commit: GitGraphEntry;
  lane: number;
  laneCount: number;
  incoming: Array<{ lane: number; hash: string }>;
  edges: GitGraphEdge[];
}

/** Assign stable lanes to commits and their parents for a compact graph renderer. */
export function layoutGitGraph(commits: readonly GitGraphEntry[]): GitGraphRow[] {
  const lanes: string[] = [];
  const rows: GitGraphRow[] = [];
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = 0;
      lanes.unshift(commit.hash);
    }
    const before = [...lanes];
    lanes.splice(lane, 1);
    commit.parents.forEach((parent, index) => {
      if (lanes.includes(parent)) return;
      lanes.splice(Math.min(lane + index, lanes.length), 0, parent);
    });
    const edges: GitGraphEdge[] = [];
    for (const hash of before) {
      if (hash === commit.hash) continue;
      const from = before.indexOf(hash);
      const to = lanes.indexOf(hash);
      if (to >= 0) edges.push({ from, to, hash });
    }
    for (const parent of commit.parents) {
      const to = lanes.indexOf(parent);
      if (to >= 0) edges.push({ from: lane, to, hash: parent });
    }
    rows.push({
      commit,
      lane,
      laneCount: Math.max(before.length, lanes.length, 1),
      incoming: before.map((hash, lane) => ({ lane, hash })),
      edges,
    });
  }
  return rows;
}

export function gitGraphColor(hash: string): string {
  let value = 0;
  for (let index = 0; index < Math.min(hash.length, 8); index++) {
    value = (value * 33 + hash.charCodeAt(index)) >>> 0;
  }
  return ["#4ea1ff", "#d77aff", "#45c486", "#f5a742", "#e66b6b", "#49c3d4"][value % 6]!;
}
