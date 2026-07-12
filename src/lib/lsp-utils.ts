import type { TextEdit } from "vscode-languageserver-protocol";

function offsetAt(
  text: string,
  position: { line: number; character: number },
): number {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + position.character, text.length);
}

/** Apply non-overlapping LSP edits using UTF-16 offsets, as required by LSP. */
export function applyLspTextEdits(text: string, edits: TextEdit[]): string {
  return edits
    .map((edit) => ({
      start: offsetAt(text, edit.range.start),
      end: offsetAt(text, edit.range.end),
      text: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce(
      (value, edit) =>
        value.slice(0, edit.start) + edit.text + value.slice(edit.end),
      text,
    );
}
