import type { GitFileChange } from "../shared/types";

export interface GitDiffExcerpt {
  key: string;
  path: string;
  staged: boolean;
}

/** Preserve distinct index and working-tree baselines for partially staged files. */
export function buildGitDiffExcerpts(
  changes: GitFileChange[],
): GitDiffExcerpt[] {
  return changes.flatMap((change) => {
    const result: GitDiffExcerpt[] = [];
    if (change.index !== " ") {
      result.push({
        key: `staged:${change.path}`,
        path: change.path,
        staged: true,
      });
    }
    if (change.working !== " ") {
      result.push({
        key: `working:${change.path}`,
        path: change.path,
        staged: false,
      });
    }
    return result;
  });
}
