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
  /** Resume a previous SDK session id for multi-turn. */
  resume?: string;
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
