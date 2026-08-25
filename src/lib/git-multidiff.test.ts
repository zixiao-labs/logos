import { describe, expect, it } from "@lightning-js/lightning";
import type { GitFileChange } from "../shared/types";
import { buildGitDiffExcerpts } from "./git-multidiff";

describe("buildGitDiffExcerpts", () => {
  it("keeps separate baselines for partially staged files", () => {
    const changes: GitFileChange[] = [
      { path: "staged.ts", index: "M", working: " ", staged: true },
      { path: "working.ts", index: " ", working: "M", staged: false },
      { path: "partial.ts", index: "M", working: "M", staged: true },
      { path: "new.ts", index: " ", working: "?", staged: false },
    ];

    expect(buildGitDiffExcerpts(changes)).toEqual([
      { key: "staged:staged.ts", path: "staged.ts", staged: true },
      { key: "working:working.ts", path: "working.ts", staged: false },
      { key: "staged:partial.ts", path: "partial.ts", staged: true },
      { key: "working:partial.ts", path: "partial.ts", staged: false },
      { key: "working:new.ts", path: "new.ts", staged: false },
    ]);
  });
});
