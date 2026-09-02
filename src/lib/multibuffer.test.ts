import { describe, expect, it } from "@lightning-js/lightning";
import { buildMultiBufferExcerpts, createMultiBufferDocument } from "./multibuffer";

describe("multibuffer excerpts", () => {
  it("merges touching context ranges while retaining each source match", () => {
    const excerpts = buildMultiBufferExcerpts(
      "search",
      [
        {
          path: "/workspace/src/app.ts",
          startLine: 10,
          startColumn: 3,
          endLine: 10,
          endColumn: 8,
          label: "first",
        },
        {
          path: "/workspace/src/app.ts",
          startLine: 14,
          startColumn: 1,
          endLine: 14,
          endColumn: 6,
          label: "second",
        },
      ],
      2,
    );

    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toMatchObject({ startLine: 8, endLine: 16 });
    expect(excerpts[0]?.matches.map((match) => match.label)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps separate files and distant ranges in separate excerpts", () => {
    const document = createMultiBufferDocument(
      "diagnostics",
      "Problems",
      "diagnostic",
      [
        {
          path: "/workspace/b.ts",
          startLine: 30,
          startColumn: 1,
          endLine: 30,
          endColumn: 2,
        },
        {
          path: "/workspace/a.ts",
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 2,
        },
        {
          path: "/workspace/a.ts",
          startLine: 20,
          startColumn: 1,
          endLine: 20,
          endColumn: 2,
        },
      ],
    );

    expect(document.excerpts.map((excerpt) => excerpt.path)).toEqual([
      "/workspace/a.ts",
      "/workspace/a.ts",
      "/workspace/b.ts",
    ]);
  });

  it("normalizes invalid coordinates at the source boundary", () => {
    const [excerpt] = buildMultiBufferExcerpts("manual", [
      {
        path: "/workspace/a.ts",
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
      },
    ]);

    expect(excerpt).toMatchObject({ startLine: 1 });
    expect(excerpt?.matches[0]).toMatchObject({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    });
  });
});
