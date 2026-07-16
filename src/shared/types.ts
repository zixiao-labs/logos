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

export type FileSnapshot =
  | { exists: true; content: string; revision: string }
  | { exists: false; revision: string };

export type ConditionalWriteResult =
  | { status: "written"; revision: string }
  | { status: "conflict"; current: FileSnapshot };

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
  /** Previous repository path for a rename. */
  originalPath?: string;
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

export interface GitFileDiff {
  path: string;
  staged: boolean;
  original: string;
  modified: string;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
  executable?: string;
  args?: string[];
  env?: Record<string, string | null>;
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
  /** Runtime used for newly-created threads. `claude` is the built-in runtime. */
  "agent.defaultRuntime": string;
  /** Model used by the Logos-owned OpenAI Responses runtime. */
  "agent.logosModel": string;
  /** Optional OpenAI-compatible API base URL. Credentials remain in safeStorage. */
  "agent.openaiBaseUrl": string;
  /** Third-party agents launched over Agent Client Protocol stdio. */
  "agent.acpServers": AcpAgentConfig[];
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

/** Reasoning effort levels exposed by the built-in model runtimes. */
export type AgentEffortLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
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
  /** Protocol value when the display label differs from the submitted value. */
  value?: string;
  /** Optional markdown/HTML preview (only when previewFormat is configured). */
  preview?: string;
}

/** One clarifying question raised by Claude's AskUserQuestion tool. */
export interface AgentQuestion {
  /** Stable field key for structured ACP elicitations. */
  id?: string;
  question: string;
  header: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
  type?: "select" | "text" | "number" | "boolean" | "url";
  required?: boolean;
  defaultValue?: string | number | boolean | string[];
  url?: string;
  allowCustom?: boolean;
}

export type AgentAnswerValue = string | string[] | number | boolean;

export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Environment name -> opaque reference resolved only in the main process. */
  secretEnv?: Record<string, string>;
  /** Registry package-runner argv that must also prefix terminal auth commands. */
  authArgsPrefix?: string[];
}

export type AgentRuntimeConfig =
  | { type: "logos" }
  | { type: "claude" }
  | { type: "acp"; server: AcpAgentConfig };

export interface AgentCredentialStatus {
  type: "none" | "api-key" | "chatgpt";
  label?: string;
  expiresAt?: number;
}

export type AcpRegistryDistributionKind = "binary" | "npx" | "uvx";

/** A launchable entry projected from the canonical ACP Registry. */
export interface AcpRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  icon?: string;
  distributionKinds: AcpRegistryDistributionKind[];
  available: boolean;
  unavailableReason?: string;
}

export interface AgentPlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export interface AgentModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface AgentConfigValue {
  value: string;
  name: string;
  description?: string;
  group?: string;
}

export type AgentConfigOption =
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "select";
      currentValue: string;
      options: AgentConfigValue[];
    }
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "boolean";
      currentValue: boolean;
    };

export interface AgentAuthMethod {
  id: string;
  name: string;
  description?: string;
  type: "agent" | "terminal" | "env_var";
  terminal?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  variables?: Array<{
    name: string;
    label?: string;
    secret: boolean;
    optional: boolean;
  }>;
}

export interface AgentToolLocation {
  path: string;
  line?: number;
}

export interface AgentToolDiff {
  path: string;
  oldText: string;
  newText: string;
}

export interface AgentPermissionOption {
  id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AgentProviderInfo {
  id: string;
  required: boolean;
  supported: string[];
  current?: { apiType: string; baseUrl: string };
}

export interface AgentProviderConfig {
  id: string;
  apiType: string;
  baseUrl: string;
  headers?: Record<string, string>;
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
  runtime?: AgentRuntimeConfig;
}

export type AgentEvent =
  | { kind: "system"; sessionId: string; subtype: string; data: unknown }
  | {
      kind: "text-delta";
      sessionId: string;
      messageId: string;
      delta: string;
      parentToolUseId?: string;
    }
  | {
      kind: "text";
      sessionId: string;
      messageId: string;
      text: string;
      parentToolUseId?: string;
    }
  | {
      kind: "thinking";
      sessionId: string;
      messageId: string;
      delta: string;
      parentToolUseId?: string;
    }
  | {
      kind: "tool-use";
      sessionId: string;
      toolUseId: string;
      name: string;
      input: unknown;
      parentToolUseId?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      toolKind?: string;
      locations?: AgentToolLocation[];
      diffs?: AgentToolDiff[];
    }
  | {
      kind: "tool-result";
      sessionId: string;
      toolUseId: string;
      isError: boolean;
      content: string;
      parentToolUseId?: string;
      locations?: AgentToolLocation[];
      diffs?: AgentToolDiff[];
    }
  | {
      kind: "tool-update";
      sessionId: string;
      toolUseId: string;
      title?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
      locations?: AgentToolLocation[];
      diffs?: AgentToolDiff[];
    }
  | {
      kind: "plan";
      sessionId: string;
      entries: AgentPlanEntry[];
    }
  | {
      kind: "subagent";
      sessionId: string;
      taskId: string;
      toolUseId?: string;
      agentType?: string;
      description: string;
      status: "pending" | "running" | "completed" | "failed" | "stopped";
      summary?: string;
    }
  | {
      kind: "runtime-ready";
      sessionId: string;
      runtimeName: string;
      sdkSessionId: string;
      modes: AgentModeInfo[];
      currentModeId?: string;
      models: AgentModelInfo[];
      currentModelId?: string;
      configOptions: AgentConfigOption[];
      commands: AgentSlashCommand[];
      authMethods: AgentAuthMethod[];
      canConfigureProviders: boolean;
    }
  | {
      kind: "mode";
      sessionId: string;
      modeId: string;
    }
  | {
      kind: "config";
      sessionId: string;
      options: AgentConfigOption[];
    }
  | {
      kind: "auth-required";
      sessionId: string;
      methods: AgentAuthMethod[];
      message?: string;
    }
  | {
      kind: "follow";
      sessionId: string;
      location: AgentToolLocation;
    }
  | {
      kind: "session-info";
      sessionId: string;
      title?: string;
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
      options?: AgentPermissionOption[];
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
  behavior?: "allow" | "deny";
  optionId?: string;
  cancelled?: boolean;
  message?: string;
}

/** Answer to an AskUserQuestion request. */
export interface AgentAskResponse {
  requestId: string;
  /** Map of question text -> chosen label(s) / free text. */
  answers: Record<string, AgentAnswerValue>;
  /** Optional free-form reply used instead of per-question answers. */
  response?: string;
  action?: "accept" | "decline" | "cancel";
}

export interface AgentAuthRequest {
  sessionId: string;
  methodId: string;
  /** Set after an IDE terminal auth command exits successfully. */
  completed?: boolean;
}

export interface AgentAuthResult {
  terminal?: TerminalCreateOptions;
}

export interface AgentSetConfigRequest {
  sessionId: string;
  configId: string;
  value: string | boolean;
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

export interface LspWorkDoneProgress {
  serverId: string;
  token: string | number;
  title: string;
  message?: string;
  percentage?: number;
  cancellable: boolean;
}

export interface LspClientRequest {
  serverId: string;
  method: string;
  params: unknown;
  signal: AbortSignal;
}

export type LspLogLevel = "info" | "warning" | "error" | "debug";

export interface LspLog {
  /** Stable renderer-store id; assigned when the log enters the store. */
  id?: number;
  /** Unix epoch milliseconds. */
  time: number;
  /** Server id when the log belongs to a specific server. */
  serverId?: string;
  level: LspLogLevel;
  message: string;
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
