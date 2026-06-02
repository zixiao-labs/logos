import type { Settings } from "./types";

/** Canonical default settings, shared by the main process and the renderer. */
export const DEFAULT_SETTINGS: Settings = {
  "workbench.layout": "vscode",
  "workbench.theme": "dark",
  "workbench.language": "en",
  "workbench.keymap": "default",
  "editor.fontSize": 13,
  "editor.fontFamily":
    '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
  "editor.tabSize": 2,
  "editor.wordWrap": "off",
  "editor.minimap": true,
  "editor.lineNumbers": "on",
  "terminal.fontSize": 12,
  "terminal.shell": "",
  "agent.model": "",
  "agent.permissionMode": "default",
  "lsp.autoDownload": true,
};
