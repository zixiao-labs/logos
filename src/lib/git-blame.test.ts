import { describe, expect, it } from "@lightning-js/lightning";
import type { GitBlameLine } from "../shared/types";
import {
  formatBlameAge,
  formatBlameTooltip,
  formatInlineBlame,
  formatStatusBarBlame,
} from "./git-blame";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const committed: GitBlameLine = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  message: "Add current-line blame",
  author: "Ada Lovelace",
  authorEmail: "ada@example.com",
  date: "2026-07-14T12:00:00.000Z",
  path: "src/editor.ts",
  originalLine: 8,
  finalLine: 10,
  uncommitted: false,
};

describe("git blame formatting", () => {
  it("formats relative ages in the selected language", () => {
    expect(formatBlameAge(committed.date, "en", NOW)).toBe("2 days ago");
    expect(formatBlameAge(committed.date, "zh", NOW)).toBe("前天");
    expect(formatBlameAge("2026-07-16T12:00:00.000Z", "en", NOW)).toBe("now");
    expect(formatBlameAge("not-a-date", "en", NOW)).toBe("not-a-date");
  });

  it("formats committed blame for inline and status-bar display", () => {
    expect(formatInlineBlame(committed, "en", NOW)).toBe(
      "Ada Lovelace, 2 days ago • Add current-line blame",
    );
    expect(formatStatusBarBlame(committed, "en", NOW)).toBe(
      "Ada Lovelace, 2 days ago",
    );
    expect(formatBlameTooltip(committed, "en")).toContain(
      "Ada Lovelace <ada@example.com>",
    );
    expect(formatBlameTooltip(committed, "en")).toContain(
      "src/editor.ts:10",
    );
  });

  it("localizes uncommitted changes and truncates long summaries", () => {
    const uncommitted = {
      ...committed,
      hash: "0".repeat(40),
      shortHash: "",
      message: "",
      authorEmail: "not.committed.yet",
      date: "2026-07-16T12:00:00.000Z",
      uncommitted: true,
    };
    expect(formatInlineBlame(uncommitted, "zh", NOW)).toBe(
      "你, 现在 • 未提交的更改",
    );
    expect(formatBlameTooltip(uncommitted, "en")).toContain(
      "Uncommitted changes",
    );
    expect(formatBlameTooltip(uncommitted, "en")).not.toContain(
      "not.committed.yet",
    );
    expect(
      formatInlineBlame(
        { ...committed, message: "x".repeat(60) },
        "en",
        NOW,
      ),
    ).toBe(`Ada Lovelace, 2 days ago • ${"x".repeat(49)}…`);
  });
});
