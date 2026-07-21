import { describe, expect, it } from "@lightning-js/lightning";
import { layoutGitGraph } from "./git-graph";
import type { GitGraphEntry } from "../shared/types";

const commit = (hash: string, parents: string[] = []): GitGraphEntry => ({
  hash,
  shortHash: hash.slice(0, 7),
  parents,
  refs: [],
  message: hash,
  author: "Tester",
  date: "2026-07-21T00:00:00Z",
});

describe("Git graph layout", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutGitGraph([
      commit("ccccccc", ["bbbbbbb"]),
      commit("bbbbbbb", ["aaaaaaa"]),
      commit("aaaaaaa"),
    ]);
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0]);
    expect(rows.every(row => row.laneCount === 1)).toBe(true);
    expect(rows.map(row => row.incoming.map(edge => edge.lane))).toEqual([
      [0],
      [0],
      [0],
    ]);
  });

  it("creates and rejoins lanes for a merge", () => {
    const rows = layoutGitGraph([
      commit("merge00", ["main000", "side000"]),
      commit("main000", ["base000"]),
      commit("side000", ["base000"]),
      commit("base000"),
    ]);
    expect(rows[0]?.laneCount).toBe(2);
    expect(rows[0]?.edges.map(edge => edge.to)).toEqual([0, 1]);
    expect(rows[2]?.lane).toBe(1);
  });
});
