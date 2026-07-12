import type { TextEdit } from "vscode-languageserver-protocol";

const MAX_WORD_PATTERN_LENGTH = 256;
const MAX_WORD_PATTERN_REPETITIONS = 20;

function repetitionEnd(pattern: string, index: number): number {
  if (pattern[index] === "*" || pattern[index] === "+" || pattern[index] === "?")
    return index;
  if (pattern[index] !== "{") return -1;
  const match = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(index));
  return match ? index + match[0].length - 1 : -1;
}

/** Conservatively reject server-provided word patterns prone to backtracking. */
export function isSafeWordPattern(pattern: string): boolean {
  if (pattern.length > MAX_WORD_PATTERN_LENGTH) return false;

  const groups = [{ repeated: false, alternating: false }];
  let inCharacterClass = false;
  let repetitions = 0;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      if (!inCharacterClass && /[1-9]/.test(pattern[i + 1] ?? "")) return false;
      if (!inCharacterClass && pattern[i + 1] === "k" && pattern[i + 2] === "<")
        return false;
      i++;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;

    if (char === "(") {
      if (pattern[i + 1] === "?" && pattern[i + 2] !== ":") return false;
      if (pattern[i + 1] === "?") i += 2;
      groups.push({ repeated: false, alternating: false });
      continue;
    }
    if (char === "|") {
      groups.at(-1)!.alternating = true;
      continue;
    }
    if (char === ")" && groups.length > 1) {
      const group = groups.pop()!;
      const end = repetitionEnd(pattern, i + 1);
      if (end >= 0) {
        if (group.repeated || group.alternating) return false;
        if (++repetitions > MAX_WORD_PATTERN_REPETITIONS) return false;
        groups.at(-1)!.repeated = true;
        i = end;
      } else {
        groups.at(-1)!.repeated ||= group.repeated;
        groups.at(-1)!.alternating ||= group.alternating;
      }
      continue;
    }

    const end = repetitionEnd(pattern, i);
    if (end >= 0) {
      if (++repetitions > MAX_WORD_PATTERN_REPETITIONS) return false;
      groups.at(-1)!.repeated = true;
      i = end;
    }
  }
  return true;
}

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
