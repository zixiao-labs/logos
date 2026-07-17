import type { CSSProperties } from "react";

export type IconName =
  | "files"
  | "search"
  | "git"
  | "debug"
  | "extensions"
  | "agent"
  | "settings"
  | "chevron-right"
  | "chevron-down"
  | "close"
  | "add"
  | "refresh"
  | "new-file"
  | "new-folder"
  | "file"
  | "folder"
  | "folder-open"
  | "terminal"
  | "split"
  | "more"
  | "error"
  | "warning"
  | "check"
  | "play"
  | "stop"
  | "pause"
  | "step-over"
  | "step-into"
  | "step-out"
  | "send"
  | "layout"
  | "sun"
  | "moon"
  | "trash"
  | "edit"
  | "preview"
  | "globe"
  | "robot"
  | "sidebar-left"
  | "sidebar-right"
  | "panel-bottom"
  | "win-min"
  | "win-max"
  | "win-close"
  | "branch"
  | "commit"
  | "discard"
  | "download"
  | "upload"
  | "translate"
  | "chevron-updown";

const PATHS: Record<IconName, string> = {
  files:
    "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  git: "M6 3v12M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a9 9 0 0 0 9-9",
  debug:
    "M8 2l1.4 2.2A7 7 0 0 1 12 3.7c.9 0 1.8.2 2.6.5L16 2m-8 7H4m16 0h-4M7 14H3m18 0h-4M8 19l-2 3m10-3 2 3M8 8h8v7a4 4 0 0 1-8 0V8zM12 8V4",
  extensions:
    "M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z",
  agent:
    "M12 8V4m0 4a4 4 0 0 0-4 4v3a4 4 0 0 0 4 4 4 4 0 0 0 4-4v-3a4 4 0 0 0-4-4zM5 12H3m18 0h-2M9 13h.01M15 13h.01",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-updown": "M7 15l5 5 5-5M7 9l5-5 5 5",
  close: "M18 6L6 18M6 6l12 12",
  add: "M12 5v14M5 12h14",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.7 4.4A9 9 0 0 0 20.5 15",
  "new-file": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6",
  "new-folder":
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2zM12 11v6M9 14h6",
  file: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  "folder-open":
    "M6 14l1.5-4h14.5l-2.5 7a2 2 0 0 1-2 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1",
  terminal: "M4 17l6-6-6-6M12 19h8",
  split: "M3 3h18v18H3zM12 3v18",
  more: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  error: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v5M12 16h.01",
  warning: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  check: "M20 6L9 17l-5-5",
  play: "M5 3l14 9-14 9V3z",
  stop: "M6 6h12v12H6z",
  pause: "M8 5v14M16 5v14",
  "step-over": "M4 17v-2a7 7 0 0 1 12-5l3 3M19 8v5h-5M12 17v.01",
  "step-into": "M12 3v13M7 11l5 5 5-5M5 21h14",
  "step-out": "M12 21V8M7 13l5-5 5 5M5 3h14",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  layout: "M3 3h18v18H3zM9 3v18M9 13h12",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
  edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
  preview: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z",
  robot: "M12 8V4H8m4 4h4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h4zM2 14h2m16 0h2M9 13v2m6-2v2",
  "sidebar-left": "M3 3h18v18H3zM9 3v18",
  "sidebar-right": "M3 3h18v18H3zM15 3v18",
  "panel-bottom": "M3 3h18v18H3zM3 15h18",
  "win-min": "M5 12h14",
  "win-max": "M5 5h14v14H5z",
  "win-close": "M18 6L6 18M6 6l12 12",
  branch: "M6 3v12M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a9 9 0 0 0 9-9",
  commit: "M3 12h6M15 12h6M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  discard: "M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7 3.3M3 4v3.3h3.3",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  upload: "M12 21V9M7 14l5-5 5 5M5 3h14",
  translate: "M5 8h8M9 4v4m1.5 0s-1 6-6.5 9M7 12c1.5 3 4 4 4 4M14 20l4-9 4 9M15.5 17h5",
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  fill?: boolean;
}

export function Icon({ name, size = 16, className, style, fill }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
