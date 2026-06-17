/**
 * Shared data shapes used across the Electron main process, the preload bridge
 * and the renderer. Keep this file free of any runtime imports from either side
 * so it can be imported from anywhere.
 */

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------

export type FileKind = "file" | "directory";

export interface FileEntry {
  name: string;
  /** Absolute path. */
  path: string;
  type: FileKind;
  /** Present for directories that are known to contain children. */
  hasChildren?: boolean;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

export interface FileStat {
  path: string;
  type: FileKind;
  size: number;
  mtimeMs: number;
}

export type FsWatchEventType = "create" | "change" | "delete" | "rename";

export interface FsWatchEvent {
  type: FsWatchEventType;
  path: string;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitFileChange {
  path: string;
  /** Single-letter index (staged) status from git, or " " when unchanged. */
  index: string;
  /** Single-letter working-tree status, or " " when unchanged. */
  working: string;
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  clean: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface TerminalCreated {
  id: string;
  pid: number;
  shell: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type LayoutMode = "vscode" | "cursor";
export type ThemeMode = "dark" | "light";
export type LanguageCode = "en" | "zh";
export type KeymapMode = "default" | "vim" | "helix";

export interface Settings {
  "workbench.layout": LayoutMode;
  "workbench.theme": ThemeMode;
  "workbench.language": LanguageCode;
  "workbench.keymap": KeymapMode;
  "editor.fontSize": number;
  "editor.fontFamily": string;
  "editor.tabSize": number;
  "editor.wordWrap": "on" | "off";
  "editor.minimap": boolean;
  "editor.lineNumbers": "on" | "off" | "relative";
  "terminal.fontSize": number;
  "terminal.shell": string;
  "agent.model": string;
  "agent.permissionMode": AgentPermissionMode;
  /** API key (sk-…) for direct Anthropic API access. Stored masked in the UI. */
  "agent.apiKey": string;
  /** OAuth/auth token (ANTHROPIC_AUTH_TOKEN) for gateway/proxy auth. */
  "agent.authToken": string;
  /** Override the Anthropic base URL (gateways, proxies). */
  "agent.baseUrl": string;
  /** Reasoning effort; "" defers to the model default. */
  "agent.effort": AgentEffortSetting;
  /** Extended-thinking mode. */
  "agent.thinking": AgentThinkingMode;
  /** Token budget used when thinking === "enabled". */
  "agent.thinkingBudget": number;
  /** Tools auto-allowed without prompting. */
  "agent.allowedTools": string[];
  /** Tools removed from the model entirely. */
  "agent.disallowedTools": string[];
  /** Load user/project .claude settings (slash-commands, agents, etc.). */
  "agent.loadProjectSettings": boolean;
  "lsp.autoDownload": boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Claude Agent
// ---------------------------------------------------------------------------

export type AgentPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/** Reasoning effort levels the SDK accepts (maps 1:1 to the SDK `EffortLevel`). */
export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
/** Effort setting value; "" means "defer to the model default". */
export type AgentEffortSetting = "" | AgentEffortLevel;
/** Extended-thinking mode exposed in settings/UI. */
export type AgentThinkingMode = "adaptive" | "enabled" | "disabled";

/** Mirrors the SDK `ThinkingConfig` discriminated union 1:1. */
export type AgentThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens?: number }
  | { type: "disabled" };

/** Which on-disk setting layers to load (maps to the SDK `SettingSource`). */
export type AgentSettingSource = "user" | "project" | "local";

/** Mirrors the SDK `ModelInfo` shape returned by `query.supportedModels()`. */
export interface AgentModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: AgentEffortLevel[];
  supportsAdaptiveThinking?: boolean;
}

/** Mirrors the SDK `SlashCommand` shape from `query.supportedCommands()`. */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

/** Credentials + cwd used to probe the SDK for models/commands (D1/D4). */
export interface AgentAuthContext {
  cwd?: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}

/** A single option Claude offers for an AskUserQuestion clarifying question. */
export interface AgentQuestionOption {
  label: string;
  description: string;
  /** Optional markdown/HTML preview (only when previewFormat is configured). */
  preview?: string;
}

/** One clarifying question raised by Claude's AskUserQuestion tool. */
export interface AgentQuestion {
  question: string;
  header: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
}

export interface AgentStartRequest {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  /** Resume a previous SDK session id for multi-turn / restart recovery. */
  resume?: string;
  /** Reasoning effort; omit to defer to the model default. */
  effort?: AgentEffortLevel;
  /** Extended-thinking configuration. */
  thinking?: AgentThinkingConfig;
  /** Tools auto-allowed without prompting. */
  allowedTools?: string[];
  /** Tools removed from the model entirely. */
  disallowedTools?: string[];
  /** Setting layers to load (enables .claude slash-commands when set). */
  settingSources?: AgentSettingSource[];
  /** Credentials supplied from settings; merged into the subprocess env. */
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}

export type AgentEvent =
  | { kind: "system"; sessionId: string; subtype: string; data: unknown }
  | { kind: "text-delta"; sessionId: string; messageId: string; delta: string }
  | { kind: "text"; sessionId: string; messageId: string; text: string }
  | { kind: "thinking"; sessionId: string; messageId: string; delta: string }
  | {
      kind: "tool-use";
      sessionId: string;
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool-result";
      sessionId: string;
      toolUseId: string;
      isError: boolean;
      content: string;
    }
  | {
      kind: "result";
      sessionId: string;
      sdkSessionId: string | null;
      isError: boolean;
      durationMs: number;
      costUsd: number | null;
      usage: unknown;
    }
  | { kind: "error"; sessionId: string; message: string }
  | {
      kind: "permission";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: unknown;
    }
  | {
      // Claude invoked the AskUserQuestion tool — present the questions and
      // return the user's selections via `respondAsk`.
      kind: "ask";
      sessionId: string;
      requestId: string;
      questions: AgentQuestion[];
    };

export interface AgentPermissionResponse {
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
}

/** Answer to an AskUserQuestion request. */
export interface AgentAskResponse {
  requestId: string;
  /** Map of question text -> chosen label(s) / free text. */
  answers: Record<string, string | string[]>;
  /** Optional free-form reply used instead of per-question answers. */
  response?: string;
}

// ---------------------------------------------------------------------------
// Language servers (Stage 2 Sprint 1)
// ---------------------------------------------------------------------------

export type LanguageServerStatus =
  | "not-installed"
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export interface LanguageServerDescriptor {
  id: string;
  label: string;
  /** Monaco language ids this server handles. */
  languages: string[];
  /** npm package providing the server (for node-based servers). */
  npmPackage?: string;
  /** Human readable description. */
  description: string;
}

export interface LanguageServerInfo extends LanguageServerDescriptor {
  status: LanguageServerStatus;
  installedVersion: string | null;
  latestVersion: string | null;
  message?: string;
}

export interface LspProgress {
  id: string;
  status: LanguageServerStatus;
  message?: string;
  /** 0..1 when known. */
  progress?: number;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface AppVersions {
  node: string;
  chrome: string;
  electron: string;
  v8: string;
  logos: string;
}

export type WindowControl = "minimize" | "maximize" | "unmaximize" | "close";

/**
 * Actions dispatched from the native application menu (built in the main process)
 * to the renderer over CH.menuAction. The renderer routes each to a store action
 * or a window CustomEvent. Role-based menu items (undo/copy/zoom/quit/…) are
 * handled natively by Electron and never travel over this channel.
 */
export type MenuAction =
  | "file.new"
  | "file.openFolder"
  | "file.openFile"
  | "file.save"
  | "file.closeEditor"
  | "view.commandPalette"
  | "view.toggleSidebar"
  | "view.togglePanel"
  | "view.explorer"
  | "view.search"
  | "view.git"
  | "view.agent"
  | "git.commit"
  | "git.pull"
  | "git.push"
  | "git.sync"
  | "git.fetch"
  | "git.refresh"
  | "terminal.new"
  | "settings.open"
  | "help.about";
