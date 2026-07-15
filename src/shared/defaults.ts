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
  "agent.apiKey": "",
  "agent.authToken": "",
  "agent.baseUrl": "",
  "agent.effort": "",
  "agent.thinking": "adaptive",
  "agent.thinkingBudget": 8000,
  "agent.allowedTools": [],
  "agent.disallowedTools": [],
  "agent.loadProjectSettings": true,
  "agent.defaultRuntime": "claude",
  "agent.acpServers": [
    {
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      args: ["acp"],
      env: {},
    },
  ],
  "lsp.autoDownload": true,
};
