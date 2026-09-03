export type MultiBufferExcerptKind =
  | "search"
  | "reference"
  | "definition"
  | "diagnostic"
  | "manual";

export interface MultiBufferSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface MultiBufferMatch extends MultiBufferSourceRange {
  id: string;
  label?: string;
  severity?: number;
}

export interface MultiBufferExcerpt {
  id: string;
  path: string;
  kind: MultiBufferExcerptKind;
  startLine: number;
  endLine: number;
  matches: MultiBufferMatch[];
}

export interface MultiBufferDocument {
  id: string;
  title: string;
  kind: MultiBufferExcerptKind;
  contextLines: number;
  excerpts: MultiBufferExcerpt[];
}

export interface MultiBufferLocation extends MultiBufferSourceRange {
  id?: string;
  path: string;
  label?: string;
  severity?: number;
}

const DEFAULT_CONTEXT_LINES = 2;

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeLocation(
  input: MultiBufferLocation,
  index: number,
): MultiBufferLocation & { id: string } {
  const startLine = positiveInteger(input.startLine, 1);
  const endLine = Math.max(startLine, positiveInteger(input.endLine, startLine));
  const startColumn = positiveInteger(input.startColumn, 1);
  const endColumn = Math.max(
    endLine === startLine ? startColumn : 1,
    positiveInteger(input.endColumn, startColumn),
  );
  return {
    ...input,
    id: input.id ?? `${input.path}:${startLine}:${startColumn}:${index}`,
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
}

/**
 * Turns source locations into Zed-style excerpts. Context ranges that overlap
 * or touch are merged, while every original match remains independently
 * addressable for highlighting and source navigation.
 */
export function buildMultiBufferExcerpts(
  kind: MultiBufferExcerptKind,
  locations: MultiBufferLocation[],
  contextLines = DEFAULT_CONTEXT_LINES,
): MultiBufferExcerpt[] {
  const context = Number.isFinite(contextLines)
    ? Math.max(0, Math.floor(contextLines))
    : DEFAULT_CONTEXT_LINES;
  const sorted = locations
    .map(normalizeLocation)
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine ||
        a.startColumn - b.startColumn ||
        a.endLine - b.endLine,
    );
  const excerpts: MultiBufferExcerpt[] = [];

  for (const location of sorted) {
    const excerptStart = Math.max(1, location.startLine - context);
    const excerptEnd = location.endLine + context;
    const previous = excerpts.at(-1);
    const match: MultiBufferMatch = {
      id: location.id,
      startLine: location.startLine,
      startColumn: location.startColumn,
      endLine: location.endLine,
      endColumn: location.endColumn,
      label: location.label,
      severity: location.severity,
    };

    if (
      previous &&
      previous.path === location.path &&
      excerptStart <= previous.endLine + 1
    ) {
      previous.endLine = Math.max(previous.endLine, excerptEnd);
      previous.matches.push(match);
      continue;
    }

    excerpts.push({
      id: `${kind}:${location.path}:${excerptStart}:${excerpts.length}`,
      path: location.path,
      kind,
      startLine: excerptStart,
      endLine: excerptEnd,
      matches: [match],
    });
  }
  return excerpts;
}

export function createMultiBufferDocument(
  id: string,
  title: string,
  kind: MultiBufferExcerptKind,
  locations: MultiBufferLocation[],
  contextLines = DEFAULT_CONTEXT_LINES,
): MultiBufferDocument {
  return {
    id,
    title,
    kind,
    contextLines,
    excerpts: buildMultiBufferExcerpts(kind, locations, contextLines),
  };
}
