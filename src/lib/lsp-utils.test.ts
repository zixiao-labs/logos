import { describe, expect, it } from "vitest";
import type { TextEdit } from "vscode-languageserver-protocol";
import { applyLspTextEdits } from "./lsp-utils";

describe("applyLspTextEdits", () => {
  it("applies multiple edits against the original document", () => {
    const edits: TextEdit[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
        newText: "ONE",
      },
      {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 5 },
        },
        newText: "THREE",
      },
    ];

    expect(applyLspTextEdits("one\ntwo\nthree", edits)).toBe(
      "ONE\ntwo\nTHREE",
    );
  });

  it("uses UTF-16 character offsets", () => {
    const edits: TextEdit[] = [
      {
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 3 },
        },
        newText: "emoji",
      },
    ];

    expect(applyLspTextEdits("a😀b", edits)).toBe("aemojib");
  });

  it("preserves CRLF line endings", () => {
    const edits: TextEdit[] = [
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 3 },
        },
        newText: "TWO",
      },
    ];

    expect(applyLspTextEdits("one\r\ntwo\r\n", edits)).toBe(
      "one\r\nTWO\r\n",
    );
  });
});
