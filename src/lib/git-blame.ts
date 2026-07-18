import type { GitBlameLine, LanguageCode } from "../shared/types";
import type * as monaco from "monaco-editor";
import { translate } from "../i18n/locales";

function locale(language: LanguageCode): LanguageCode {
  return language === "zh" ? "zh" : "en";
}

function displayAuthor(blame: GitBlameLine, language: LanguageCode): string {
  return blame.uncommitted ? translate(language, "git.blame.you") : blame.author;
}

function displayMessage(blame: GitBlameLine, language: LanguageCode): string {
  return blame.uncommitted
    ? translate(language, "git.blame.uncommitted")
    : blame.message;
}

export function formatBlameAge(
  date: string,
  language: LanguageCode,
  now = Date.now(),
): string {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return date;
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;
  const formatter = new Intl.RelativeTimeFormat(locale(language), {
    numeric: "auto",
  });

  if (absolute < minute) return formatter.format(0, "second");
  if (absolute < hour) {
    return formatter.format(Math.round(delta / minute), "minute");
  }
  if (absolute < day) return formatter.format(Math.round(delta / hour), "hour");
  if (absolute < month) return formatter.format(Math.round(delta / day), "day");
  if (absolute < year) {
    return formatter.format(Math.round(delta / month), "month");
  }
  return formatter.format(Math.round(delta / year), "year");
}

export function formatInlineBlame(
  blame: GitBlameLine,
  language: LanguageCode,
  now = Date.now(),
): string {
  const message = displayMessage(blame, language);
  const truncated = message.length > 50 ? `${message.slice(0, 49)}…` : message;
  return `${displayAuthor(blame, language)}, ${formatBlameAge(blame.date, language, now)}${
    truncated ? ` • ${truncated}` : ""
  }`;
}

export function formatStatusBarBlame(
  blame: GitBlameLine,
  language: LanguageCode,
  now = Date.now(),
): string {
  return `${displayAuthor(blame, language)}, ${formatBlameAge(blame.date, language, now)}`;
}

export function formatBlameTooltip(
  blame: GitBlameLine,
  language: LanguageCode,
): string {
  const date = new Intl.DateTimeFormat(locale(language), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(blame.date));
  const identity = !blame.uncommitted && blame.authorEmail
    ? `${displayAuthor(blame, language)} <${blame.authorEmail}>`
    : displayAuthor(blame, language);
  return [
    displayMessage(blame, language),
    "",
    identity,
    date,
    ...(blame.uncommitted ? [] : [blame.hash]),
    `${blame.path}:${blame.finalLine}`,
  ].join("\n");
}

export function createInlineBlameDecorationOptions(
  blame: GitBlameLine,
  language: LanguageCode,
  cursorStops: monaco.editor.InjectedTextCursorStops,
): monaco.editor.IModelDecorationOptions {
  const hover = formatBlameTooltip(blame, language).replaceAll(
    "```",
    "` ` `",
  );
  return {
    after: {
      content: `   ${formatInlineBlame(blame, language)}`,
      inlineClassName: "logos-inline-blame",
      cursorStops,
    },
    hoverMessage: { value: `\`\`\`text\n${hover}\n\`\`\`` },
    // The decoration is anchored to an empty range at the end of the line.
    // Monaco otherwise suppresses its injected text as a collapsed decoration.
    showIfCollapsed: true,
  };
}
