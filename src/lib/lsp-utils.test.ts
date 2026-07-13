import { describe, expect, it } from "@lightning-js/lightning";
import type { TextEdit } from "vscode-languageserver-protocol";
import { applyLspTextEdits, isSafeWordPattern } from "./lsp-utils";

function edit(
  start: [number, number],
  end: [number, number],
  newText: string,
): TextEdit {
  return {
    range: {
      start: { line: start[0], character: start[1] },
      end: { line: end[0], character: end[1] },
    },
    newText,
  };
}

describe("isSafeWordPattern", () => {
  it("accepts ordinary lexical patterns", () => {
    expect(isSafeWordPattern("(?:[A-Za-z_$][\\w$]*|[0-9]+)")).toBe(true);
  });

  it("rejects oversized and complex patterns", () => {
    expect(isSafeWordPattern("a".repeat(257))).toBe(false);
    expect(isSafeWordPattern("(a+)+$")).toBe(false);
    expect(isSafeWordPattern("(a|aa)+$")).toBe(false);
    expect(isSafeWordPattern("(a)\\1")).toBe(false);
    expect(isSafeWordPattern("(?=word)word")).toBe(false);
    expect(isSafeWordPattern("(?<word>a)\\k<word>")).toBe(false);
  });

  it("accepts escaped metacharacters and enforces repetition limits", () => {
    expect(isSafeWordPattern("\\(word\\)\\+")).toBe(true);
    expect(isSafeWordPattern("a+".repeat(20))).toBe(true);
    expect(isSafeWordPattern("a+".repeat(21))).toBe(false);
  });
});

describe("applyLspTextEdits", () => {
  it("applies multiple edits against the original document", () => {
    const edits = [edit([0, 0], [0, 3], "ONE"), edit([2, 0], [2, 5], "THREE")];

    expect(applyLspTextEdits("one\ntwo\nthree", edits)).toBe(
      "ONE\ntwo\nTHREE",
    );
  });

  it("uses UTF-16 character offsets", () => {
    const edits = [edit([0, 1], [0, 3], "emoji")];

    expect(applyLspTextEdits("a😀b", edits)).toBe("aemojib");
  });

  it("preserves CRLF line endings", () => {
    const edits = [edit([1, 0], [1, 3], "TWO")];

    expect(applyLspTextEdits("one\r\ntwo\r\n", edits)).toBe(
      "one\r\nTWO\r\n",
    );
  });

  it("clamps invalid positions to their line instead of crossing line endings", () => {
    expect(
      applyLspTextEdits("one\ntwo", [edit([0, 99], [0, 99], "!")]),
    ).toBe("one!\ntwo");
    expect(
      applyLspTextEdits("one\r\ntwo", [edit([0, 99], [0, 99], "!")]),
    ).toBe("one!\r\ntwo");
    expect(
      applyLspTextEdits("one", [edit([-1, -2], [-1, -2], "!")]),
    ).toBe("!one");
  });

  it("supports insertions, deletions, and positions beyond the document", () => {
    expect(applyLspTextEdits("abc", [])).toBe("abc");
    expect(applyLspTextEdits("abc", [edit([0, 1], [0, 2], "")])).toBe(
      "ac",
    );
    expect(applyLspTextEdits("abc", [edit([10, 0], [10, 0], "!")])).toBe(
      "abc!",
    );
  });
});
