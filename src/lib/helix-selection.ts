/** Helix ranges are directional, half-open UTF-16 offsets (like Monaco). */
export interface HelixSelection {
  anchor: number;
  head: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function nextChar(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const part = graphemes.segment(text).containing(Math.max(0, offset));
  return part ? part.index + part.segment.length : text.length;
}

export function previousChar(text: string, offset: number): number {
  return graphemes.segment(text).containing(Math.max(0, offset - 1))?.index ?? 0;
}

export function cursorOf(text: string, range: HelixSelection): number {
  return range.head > range.anchor ? previousChar(text, range.head) : range.head;
}

export function characterSelection(text: string, offset: number): HelixSelection {
  const head = Math.min(text.length, Math.max(0, offset));
  return { anchor: head, head: nextChar(text, head) };
}

export function moveSelection(
  text: string,
  range: HelixSelection,
  position: number,
  extend: boolean,
): HelixSelection {
  if (!extend) return characterSelection(text, position);
  const anchor = range.anchor > range.head
    ? previousChar(text, range.anchor)
    : range.anchor;
  return position < anchor
    ? { anchor: nextChar(text, anchor), head: position }
    : { anchor, head: nextChar(text, position) };
}

function category(char: string, long: boolean): number {
  if (/\s/u.test(char)) return 0;
  return long || /[\p{L}\p{N}\p{M}_]/u.test(char) ? 1 : 2;
}

/** Word motions select up to a boundary; repeated motions start a new range. */
export function wordSelection(
  text: string,
  range: HelixSelection,
  motion: string,
  count: number,
  extend: boolean,
): HelixSelection {
  const backwards = motion.toLowerCase() === "b";
  const end = motion.toLowerCase() === "e";
  const long = motion === motion.toUpperCase();
  let head = backwards ? cursorOf(text, range) : nextChar(text, cursorOf(text, range));
  let anchor = backwards ? nextChar(text, head) : cursorOf(text, range);
  const boundary = (left: string, right: string) => {
    const a = category(left, long);
    const b = category(right, long);
    return a !== b && (end ? a !== 0 : b !== 0);
  };
  for (let step = 0; step < count; step++) {
    const initial = head;
    while (backwards ? head > 0 : head < text.length) {
      const left = text.slice(previousChar(text, head), head);
      const right = text.slice(head, nextChar(text, head));
      if (boundary(left, right)) {
        if (head === initial) anchor = head;
        else break;
      }
      head = backwards ? previousChar(text, head) : nextChar(text, head);
    }
  }
  if (extend) {
    const target = backwards ? head : previousChar(text, head);
    return moveSelection(text, range, target, true);
  }
  return head === anchor ? characterSelection(text, head) : { anchor, head };
}

export function selectionBounds(range: HelixSelection): [number, number] {
  return [Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)];
}

export function textObject(
  text: string,
  range: HelixSelection,
  object: string,
  around: boolean,
): HelixSelection | null {
  const cursor = cursorOf(text, range);
  let start = cursor;
  let end = nextChar(text, cursor);
  if (object === "w" || object === "W") {
    const kind = category(text.slice(cursor, end), object === "W");
    while (start > 0) {
      const prev = previousChar(text, start);
      if (category(text.slice(prev, start), object === "W") !== kind) break;
      start = prev;
    }
    while (end < text.length && category(text.slice(end, nextChar(text, end)), object === "W") === kind) {
      end = nextChar(text, end);
    }
    if (around && kind !== 0) {
      const before = end;
      while (end < text.length && /[ \t]/.test(text[end])) end++;
      if (end === before) while (start > 0 && /[ \t]/.test(text[start - 1])) start--;
    }
    return { anchor: start, head: end };
  }
  if (object === "p") {
    start = text.lastIndexOf("\n\n", cursor) + 2;
    if (start === 1) start = 0;
    end = text.indexOf("\n\n", cursor);
    if (end < 0) end = text.length;
    else if (around) end += 2;
    return { anchor: start, head: end };
  }
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`" };
  const open = pairs[object] ? object : Object.keys(pairs).find(key => pairs[key] === object);
  if (!open) return null;
  const close = pairs[open];
  const stack: number[] = [];
  const matches: [number, number][] = [];
  for (let index = 0; index < text.length; index++) {
    // An odd number of preceding backslashes escapes a quote.
    if (open === close && text[index] === open) {
      let slashes = 0;
      for (let p = index - 1; p >= 0 && text[p] === "\\"; p--) slashes++;
      if (slashes % 2) continue;
      if (stack.length) matches.push([stack.pop()!, index]);
      else stack.push(index);
    } else if (text[index] === open) stack.push(index);
    else if (text[index] === close && stack.length) matches.push([stack.pop()!, index]);
  }
  const pair = matches
    .filter(([from, to]) => from <= cursor && cursor <= to)
    .sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
  return pair ? { anchor: pair[0] + (around ? 0 : 1), head: pair[1] + (around ? 1 : 0) } : null;
}

export function regexSelections(
  text: string,
  ranges: HelixSelection[],
  pattern: string,
  split: boolean,
): HelixSelection[] {
  const regex = new RegExp(pattern, "gmu");
  const result: HelixSelection[] = [];
  for (const range of ranges) {
    const [start, end] = selectionBounds(range);
    const selected = text.slice(start, end);
    let previous = 0;
    for (const match of selected.matchAll(regex)) {
      const from = split ? previous : match.index;
      const to = split ? match.index : match.index + match[0].length;
      if (from < to || !split) result.push({ anchor: start + from, head: start + to });
      previous = match.index + match[0].length;
    }
    if (split && previous < selected.length) result.push({ anchor: start + previous, head: end });
  }
  return result;
}
