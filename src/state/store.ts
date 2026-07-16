import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { isSensitiveEnvName } from "../shared/acp-env";
import type {
  AgentAuthContext,
  AgentAuthMethod,
  AgentAuthResult,
  AgentCredentialStatus,
  AgentConfigOption,
  AgentEvent,
  AgentModelInfo,
  AgentPlanEntry,
  AgentQuestion,
  AgentSlashCommand,
  AgentToolDiff,
  AgentToolLocation,
  AgentThinkingConfig,
  AcpRegistryAgent,
  GitBlameLine,
  GitStatus,
  GitLogEntry,
  LanguageCode,
  LayoutMode,
  LspLog,
  LspProgress,
  LspWorkDoneProgress,
  Settings,
  TerminalCreateOptions,
  ThemeMode,
} from "../shared/types";
import { basename, languageFromPath } from "../lib/language";
import { notifyResult } from "../lib/toast";
import {
  DEFAULT_DEBUG_CONFIGURATION,
  parseDebugConfigurationFile,
  resolveDebugConfiguration,
} from "../lib/debug-config";
import type {
  DapBreakpoint,
  DapContinuedEventBody,
  DapEvaluateResult,
  DapOutputEventBody,
  DapScope,
  DapSourceBreakpoint,
  DapStackFrame,
  DapStoppedEventBody,
  DapThread,
  DapVariable,
  DebugAdapterInfo,
  DebugBreakpointState,
  DebugConsoleEntry,
  DebugLaunchConfiguration,
  DebugSessionEvent,
  DebugSessionInfo,
} from "../shared/dap";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type TabKind =
  | "file"
  | "diff"
  | "debug-source"
  | "preview"
  | "settings"
  | "extensions"
  | "welcome"
  | "webview";

export interface EditorTab {
  id: string;
  kind: TabKind;
  name: string;
  path?: string;
  language?: string;
  dirty?: boolean;
  externalChange?: "changed" | "deleted";
  url?: string;
  content?: string;
  debugPosition?: { line: number; column: number };
  debugSessionId?: string;
  diff?: { path: string; staged: boolean };
}

export type SidebarView =
  | "explorer"
  | "search"
  | "git"
  | "debug"
  | "extensions"
  | "agent";
export type PanelTab = "problems" | "output" | "debug" | "terminal" | "ports";
export type StoredLspLog = LspLog & { id: number };

let nextLspLogId = 1;
let nextDebugConsoleId = 1;
let nextDebugThreadRequestId = 1;
let nextDebugFrameRequestId = 1;
let activeDebugThreadRequestId = 0;
let activeDebugFrameRequestId = 0;
const debugBreakpointRequestVersions = new Map<string, number>();
let debugConfigurationRequestVersion = 0;
let nextDebugVariablePageReference = -1;
const debugVariablePages = new Map<
  number,
  {
    reference: number;
    filter: "indexed" | "named";
    start: number;
    count: number;
  }
>();

export interface TerminalInstance {
  id: string;
  name: string;
  pid: number;
}

export type AgentItem =
  | { id: string; kind: "user"; text: string }
  | {
      id: string;
      kind: "assistant";
      text: string;
      thinking: string;
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      isError?: boolean;
      result?: string;
      parentToolUseId?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      toolKind?: string;
      locations?: AgentToolLocation[];
      diffs?: AgentToolDiff[];
    }
  | {
      id: string;
      kind: "subagent";
      taskId: string;
      toolUseId?: string;
      agentType?: string;
      description: string;
      status: "pending" | "running" | "completed" | "failed" | "stopped";
      summary?: string;
    }
  | { id: string; kind: "result"; costUsd: number | null; durationMs: number }
  | { id: string; kind: "error"; message: string };

export interface AgentThread {
  id: string;
  name: string;
  items: AgentItem[];
  status: "idle" | "running" | "waiting";
  runtimeId: string;
  runtimeName?: string;
  workspaceRoot?: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  followMode: boolean;
  plan: AgentPlanEntry[];
  modeId?: string;
  modes: Array<{ id: string; name: string; description?: string }>;
  currentModelId?: string;
  models: AgentModelInfo[];
  configOptions: AgentConfigOption[];
  authMethods: AgentAuthMethod[];
  commands: AgentSlashCommand[];
  canConfigureProviders: boolean;
  trace: AgentTraceEntry[];
  /** SDK session id captured from the result event; used to resume (F2). */
  sdkSessionId?: string;
  pendingAsk?: { requestId: string; questions: AgentQuestion[] };
  pendingPermission?: {
    requestId: string;
    toolName: string;
    input: unknown;
    options?: Array<{
      id: string;
      name: string;
      kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
    }>;
  };
}

export interface AgentTraceEntry {
  id: string;
  time: number;
  subtype: string;
  data: unknown;
}

/** Kept as a source-compatible alias while the UI migrates to Thread naming. */
export type AgentSession = AgentThread;

export interface Diagnostic {
  message: string;
  severity: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  source?: string;
}

export interface CurrentLineBlame {
  path: string;
  line: number;
  blame: GitBlameLine;
}

export interface DebugViewState {
  sessions: Record<string, DebugSessionInfo>;
  activeSessionId: string | null;
  adapters: DebugAdapterInfo[];
  configurations: DebugLaunchConfiguration[];
  configurationPath: string | null;
  configurationError: string | null;
  breakpoints: Record<string, DebugBreakpointState[]>;
  threads: DapThread[];
  selectedThreadId: number | null;
  stackFrames: DapStackFrame[];
  selectedFrameId: number | null;
  scopes: DapScope[];
  variables: Record<number, DapVariable[]>;
  console: DebugConsoleEntry[];
  stoppedReason: string | null;
  pausedSessionId: string | null;
  pauseGeneration: number;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface LogosState {
  ready: boolean;
  settings: Settings;
  root: string | null;
  recent: string[];

  sidebarView: SidebarView;
  sidebarVisible: boolean;
  sidebarWidth: number;
  secondaryVisible: boolean;
  secondaryWidth: number;
  panelVisible: boolean;
  panelTab: PanelTab;
  panelHeight: number;

  tabs: EditorTab[];
  activeTabId: string | null;
  cursor: { line: number; col: number };

  terminals: TerminalInstance[];
  activeTerminalId: string | null;

  git: GitStatus | null;
  /** The current HEAD commit, shown at the top of the Source Control panel. */
  gitHead: GitLogEntry | null;
  currentLineBlame: CurrentLineBlame | null;
  diagnostics: Record<string, Diagnostic[]>;
  /** Language-server status keyed by server id (C1: surfaced in the status bar). */
  lsp: Record<string, LspProgress>;
  /** Language-server stderr/installer/client logs shown in the Output panel. */
  lspLogs: StoredLspLog[];
  lspWorkDone: Record<string, LspWorkDoneProgress>;

  debug: DebugViewState;

  agentSessions: AgentThread[];
  activeAgentId: string | null;
  /** Cached model list from the SDK (D1). Empty until loaded / if unavailable. */
  agentModels: AgentModelInfo[];
  /** Cached slash-commands from the SDK (D4). */
  agentCommands: AgentSlashCommand[];
  agentRegistry: AcpRegistryAgent[];
  agentCredentialStatus: AgentCredentialStatus;

  paletteOpen: boolean;

  // actions
  bootstrap(): Promise<void>;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
  setManySettings(patch: Partial<Settings>): Promise<void>;
  resetSettings(): Promise<void>;
  toggleLayout(): void;
  toggleTheme(): void;
  toggleLanguage(): void;

  openFolder(): Promise<void>;
  setRoot(path: string): Promise<void>;

  openFile(path: string): void;
  openGitDiff(path: string, staged: boolean): void;
  openSpecial(kind: "settings" | "extensions" | "welcome"): void;
  openPreview(path: string): void;
  openWebview(url: string, name: string): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  setDirty(id: string, dirty: boolean): void;
  setCursor(line: number, col: number): void;

  setSidebarView(v: SidebarView): void;
  toggleSidebar(): void;
  toggleSecondary(): void;
  togglePanel(): void;
  setPanelTab(t: PanelTab): void;
  setSidebarWidth(w: number): void;
  setSecondaryWidth(w: number): void;
  setPanelHeight(h: number): void;

  newTerminal(options?: TerminalCreateOptions): Promise<void>;
  closeTerminal(id: string): void;
  setActiveTerminal(id: string): void;

  refreshGit(): Promise<void>;
  /** Git remote actions shared by the SCM panel and the native menu. */
  gitFetch(): Promise<void>;
  gitPull(): Promise<void>;
  gitPush(): Promise<void>;
  gitSync(): Promise<void>;
  setCurrentLineBlame(blame: CurrentLineBlame | null): void;
  setDiagnostics(path: string, diags: Diagnostic[]): void;
  setLspProgress(p: LspProgress): void;
  appendLspLog(entry: LspLog): void;
  clearLspLogs(): void;
  setLspWorkDone(progress: LspWorkDoneProgress): void;
  clearLspWorkDone(serverId: string, token: string | number): void;
  loadAgentModels(): Promise<void>;
  loadAgentCommands(): Promise<void>;
  loadAgentRegistry(forceRefresh?: boolean): Promise<void>;
  refreshAgentAuth(): Promise<void>;
  loginChatGPT(): Promise<void>;
  setOpenAIKey(apiKey: string): Promise<void>;
  logoutOpenAI(): Promise<void>;

  loadDebugConfigurations(): Promise<void>;
  createDebugConfiguration(): Promise<void>;
  startDebug(configuration?: DebugLaunchConfiguration): Promise<void>;
  stopDebug(): Promise<void>;
  debugContinue(): Promise<void>;
  debugPause(): Promise<void>;
  debugStep(command: "next" | "stepIn" | "stepOut"): Promise<void>;
  toggleBreakpoint(path: string, line: number): Promise<void>;
  selectDebugThread(threadId: number): Promise<void>;
  selectDebugFrame(frameId: number): Promise<void>;
  loadDebugVariables(reference: number): Promise<void>;
  evaluateDebug(expression: string): Promise<void>;
  clearDebugConsole(): void;
  applyDebugEvent(event: DebugSessionEvent): void;

  newAgentSession(name?: string, parentId?: string, runtimeId?: string): string;
  removeAgentSession(id: string): void;
  setActiveAgent(id: string): void;
  setAgentRuntime(id: string, runtimeId: string): void;
  setAgentMode(id: string, modeId: string): Promise<void>;
  setAgentModel(id: string, modelId: string): Promise<void>;
  setAgentConfig(id: string, configId: string, value: string | boolean): Promise<void>;
  toggleAgentFollow(id: string): void;
  authenticateAgent(id: string, methodId: string): Promise<void>;
  sendAgentPrompt(text: string): Promise<void>;
  interruptAgent(): Promise<void>;
  answerAsk(
    requestId: string,
    answers: Record<string, string | string[] | number | boolean>,
    response?: string,
    action?: "accept" | "decline" | "cancel",
  ): Promise<void>;
  respondPermission(
    requestId: string,
    behavior: "allow" | "deny",
    optionId?: string,
  ): Promise<void>;
  applyAgentEvent(e: AgentEvent): void;

  openPalette(): void;
  closePalette(): void;
}

function makeWelcomeTab(): EditorTab {
  return { id: "welcome", kind: "welcome", name: "Welcome" };
}

/** Translate the `agent.thinking` setting into the SDK's discriminated union. */
function thinkingConfig(
  mode: Settings["agent.thinking"],
  budget: number,
): AgentThinkingConfig | undefined {
  if (mode === "disabled") return { type: "disabled" };
  if (mode === "enabled") return { type: "enabled", budgetTokens: budget };
  return undefined; // "adaptive" => defer to the model/SDK default
}

function stringifyAgentValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function agentTraceData(value: unknown): string {
  const serialized = stringifyAgentValue(value);
  return serialized.length > 32_768
    ? `${serialized.slice(0, 32_768)}\n...[trace truncated]`
    : serialized;
}

/** Build the credential/cwd context used to probe SDK models/commands. */
function agentAuthCtx(state: {
  root: string | null;
  settings: Settings;
}): AgentAuthContext {
  const s = state.settings;
  return {
    cwd: state.root ?? undefined,
    apiKey: s["agent.apiKey"] || undefined,
    authToken: s["agent.authToken"] || undefined,
    baseUrl: s["agent.baseUrl"] || undefined,
  };
}

// --- Agent session persistence (F2) ---------------------------------------
// Session metadata remains in localStorage, while potentially large transcripts
// live in IndexedDB. Transient state (running status, pending permission/ask) is
// never restored because the main-process side is gone after a restart.
const AGENT_PERSIST_KEY = "logos.agent.threads.v2";
const LEGACY_AGENT_PERSIST_KEY = "logos.agent.v1";
const AGENT_TRANSCRIPT_DB = "logos.agent.transcripts.v1";
const AGENT_TRANSCRIPT_STORE = "transcripts";
const AGENT_TRANSCRIPT_ITEM_LIMIT = 2_000;
const AGENT_TRANSCRIPT_THREAD_BYTES = 2 * 1024 * 1024;
const AGENT_TRANSCRIPT_TOTAL_BYTES = 20 * 1024 * 1024;

interface AgentTranscriptRecord {
  id: string;
  items: AgentItem[];
  updatedAt: number;
  bytes: number;
}

const transcriptEncoder = new TextEncoder();
let transcriptDbPromise: Promise<IDBDatabase | null> | null = null;

function serializedBytes(value: unknown): number {
  try {
    return transcriptEncoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function serializableAgentItem(item: AgentItem): AgentItem {
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(item, (_key, value: unknown) => {
      if (typeof value === "bigint") return String(value);
      if (typeof value === "function" || typeof value === "symbol") {
        return String(value);
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    if (serialized) return JSON.parse(serialized) as AgentItem;
  } catch {
    // Fall through to a small, cloneable item rather than losing the snapshot.
  }
  return {
    id: item.id,
    kind: "error",
    message: "Transcript item could not be serialized",
  };
}

function trailingText(
  value: string | undefined,
  limit: number,
): string | undefined {
  if (value == null || value.length <= limit) return value;
  if (limit <= 0) return "[truncated]";
  return `[truncated]${value.slice(-limit)}`;
}

function compactAgentItem(item: AgentItem, byteBudget: number): AgentItem {
  const contentLimit = Math.max(0, Math.floor(byteBudget / 16));
  const id = trailingText(item.id, 256) ?? "";
  switch (item.kind) {
    case "user":
      return {
        id,
        kind: "user",
        text: trailingText(item.text, contentLimit) ?? "",
      };
    case "assistant":
      return {
        id,
        kind: "assistant",
        text: trailingText(item.text, contentLimit) ?? "",
        thinking: trailingText(item.thinking, contentLimit) ?? "",
        parentToolUseId: trailingText(item.parentToolUseId, 256),
      };
    case "tool":
      return {
        id,
        kind: "tool",
        toolUseId: trailingText(item.toolUseId, 256) ?? "",
        name: trailingText(item.name, 512) ?? "",
        input: trailingText(stringifyAgentValue(item.input), contentLimit),
        isError: item.isError,
        result: trailingText(item.result, contentLimit),
        parentToolUseId: trailingText(item.parentToolUseId, 256),
        status: item.status,
        toolKind: trailingText(item.toolKind, 256),
      };
    case "subagent":
      return {
        id,
        kind: "subagent",
        taskId: trailingText(item.taskId, 256) ?? "",
        toolUseId: trailingText(item.toolUseId, 256),
        agentType: trailingText(item.agentType, 256),
        description: trailingText(item.description, contentLimit) ?? "",
        status: item.status,
        summary: trailingText(item.summary, contentLimit),
      };
    case "result":
      return {
        id,
        kind: "result",
        costUsd: item.costUsd,
        durationMs: item.durationMs,
      };
    case "error":
      return {
        id,
        kind: "error",
        message: trailingText(item.message, contentLimit) ?? "",
      };
  }
}

function boundAgentTranscript(
  items: AgentItem[],
  byteLimit = AGENT_TRANSCRIPT_THREAD_BYTES,
): { items: AgentItem[]; bytes: number } {
  if (byteLimit <= 0 || items.length === 0) return { items: [], bytes: 0 };
  const bounded = items
    .slice(-AGENT_TRANSCRIPT_ITEM_LIMIT)
    .map(serializableAgentItem);
  const sizes = bounded.map(serializedBytes);
  let bytes =
    2 +
    sizes.reduce((total, size) => total + size, 0) +
    Math.max(0, bounded.length - 1);
  let first = 0;
  while (bytes > byteLimit && bounded.length - first > 1) {
    bytes -= sizes[first] + 1;
    first += 1;
  }
  let result = bounded.slice(first);
  if (bytes > byteLimit && result.length === 1) {
    let budget = byteLimit;
    let compacted = compactAgentItem(result[0], budget);
    bytes = 2 + serializedBytes(compacted);
    while (bytes > byteLimit && budget > 0) {
      budget = Math.floor(budget / 2);
      compacted = compactAgentItem(result[0], budget);
      bytes = 2 + serializedBytes(compacted);
    }
    result = bytes <= byteLimit ? [compacted] : [];
  }
  return { items: result, bytes: result.length ? bytes : 0 };
}

function boundAgentTranscriptRecords(
  transcripts: Array<Pick<AgentTranscriptRecord, "id" | "items" | "updatedAt">>,
): AgentTranscriptRecord[] {
  const records = transcripts.map(({ id, items, updatedAt }) => ({
    id,
    updatedAt,
    ...boundAgentTranscript(items),
  }));
  let total = records.reduce((sum, record) => sum + record.bytes, 0);
  for (const record of [...records].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (total <= AGENT_TRANSCRIPT_TOTAL_BYTES) break;
    const previousBytes = record.bytes;
    const allowance = Math.max(
      0,
      AGENT_TRANSCRIPT_TOTAL_BYTES - (total - previousBytes),
    );
    const bounded = boundAgentTranscript(record.items, allowance);
    record.items = bounded.items;
    record.bytes = bounded.bytes;
    total += record.bytes - previousBytes;
  }
  return records.filter((record) => record.items.length > 0);
}

function mergeAgentTranscriptItems(
  stored: AgentItem[],
  current: AgentItem[],
): AgentItem[] {
  const merged = [...stored];
  const indices = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of current) {
    const index = indices.get(item.id);
    if (index === undefined) {
      indices.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[index] = item;
    }
  }
  return merged;
}

function openAgentTranscriptDb(): Promise<IDBDatabase | null> {
  if (transcriptDbPromise) return transcriptDbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  let resolveOpening!: (db: IDBDatabase | null) => void;
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    resolveOpening = resolve;
  });
  transcriptDbPromise = opening;
  let settled = false;
  const finish = (db: IDBDatabase | null) => {
    if (settled) {
      db?.close();
      return;
    }
    settled = true;
    if (!db && transcriptDbPromise === opening) transcriptDbPromise = null;
    resolveOpening(db);
  };
  try {
    const request = indexedDB.open(AGENT_TRANSCRIPT_DB, 1);
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(AGENT_TRANSCRIPT_STORE)) {
          request.result.createObjectStore(AGENT_TRANSCRIPT_STORE, {
            keyPath: "id",
          });
        }
      } catch {
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (transcriptDbPromise === opening) transcriptDbPromise = null;
      };
      finish(db);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  } catch {
    finish(null);
  }
  return opening;
}

async function loadAgentTranscripts(): Promise<{
  success: boolean;
  records: AgentTranscriptRecord[];
}> {
  try {
    const db = await openAgentTranscriptDb();
    if (!db) return { success: false, records: [] };
    const result = await new Promise<{
      success: boolean;
      records: AgentTranscriptRecord[];
    }>((resolve) => {
      try {
        const request = db
          .transaction(AGENT_TRANSCRIPT_STORE, "readonly")
          .objectStore(AGENT_TRANSCRIPT_STORE)
          .getAll();
        request.onsuccess = () =>
          resolve({
            success: true,
            records: request.result as AgentTranscriptRecord[],
          });
        request.onerror = () => resolve({ success: false, records: [] });
      } catch {
        resolve({ success: false, records: [] });
      }
    });
    if (!result.success) return result;
    return {
      success: true,
      records: boundAgentTranscriptRecords(
        result.records.filter(
        (record) =>
          record &&
          typeof record.id === "string" &&
          Array.isArray(record.items) &&
          typeof record.updatedAt === "number",
        ),
      ),
    };
  } catch {
    return { success: false, records: [] };
  }
}

async function persistAgentTranscripts(
  agentSessions: AgentThread[],
): Promise<boolean> {
  try {
    const db = await openAgentTranscriptDb();
    if (!db) return false;
    const records = boundAgentTranscriptRecords(agentSessions);
    return await new Promise<boolean>((resolve) => {
      try {
        const transaction = db.transaction(AGENT_TRANSCRIPT_STORE, "readwrite");
        const store = transaction.objectStore(AGENT_TRANSCRIPT_STORE);
        store.clear();
        for (const record of records) store.put(record);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
        transaction.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  } catch {
    // IndexedDB is optional; transcripts remain available for this renderer run.
    return false;
  }
}

function loadPersistedAgent(): {
  agentSessions: AgentThread[];
  activeAgentId: string | null;
} {
  try {
    const raw =
      localStorage.getItem(AGENT_PERSIST_KEY) ??
      localStorage.getItem(LEGACY_AGENT_PERSIST_KEY);
    if (!raw) return { agentSessions: [], activeAgentId: null };
    const parsed = JSON.parse(raw) as {
      agentSessions?: Array<Partial<AgentThread> & Pick<AgentThread, "id" | "name">>;
      activeAgentId?: string | null;
    };
    const agentSessions = (parsed.agentSessions ?? []).map(
      (a): AgentThread => ({
        id: a.id,
        name: a.name,
        // Read old localStorage transcripts once so they can migrate to IndexedDB.
        items: a.items ?? [],
        sdkSessionId: a.sdkSessionId,
        runtimeId: a.runtimeId ?? "claude",
        runtimeName: a.runtimeName,
        workspaceRoot: a.workspaceRoot,
        parentId: a.parentId,
        createdAt: a.createdAt ?? Date.now(),
        updatedAt: a.updatedAt ?? Date.now(),
        followMode: a.followMode ?? true,
        plan: a.plan ?? [],
        modeId: a.modeId,
        modes: a.modes ?? [],
        currentModelId: a.currentModelId,
        models: a.models ?? [],
        configOptions: a.configOptions ?? [],
        authMethods: a.authMethods ?? [],
        commands: a.commands ?? [],
        canConfigureProviders: a.canConfigureProviders ?? false,
        trace: [],
        status: "idle",
      }),
    );
    const activeAgentId =
      agentSessions.find((a) => a.id === parsed.activeAgentId)?.id ??
      agentSessions[0]?.id ??
      null;
    return { agentSessions, activeAgentId };
  } catch {
    return { agentSessions: [], activeAgentId: null };
  }
}

function persistAgent(
  agentSessions: AgentThread[],
  activeAgentId: string | null,
): void {
  try {
    localStorage.setItem(
      AGENT_PERSIST_KEY,
      JSON.stringify({
        agentSessions: agentSessions.map((a) => ({
          id: a.id,
          name: a.name,
          sdkSessionId: a.sdkSessionId,
          runtimeId: a.runtimeId,
          runtimeName: a.runtimeName,
          workspaceRoot: a.workspaceRoot,
          parentId: a.parentId,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          followMode: a.followMode,
          plan: a.plan,
          modeId: a.modeId,
          modes: a.modes,
          currentModelId: a.currentModelId,
          models: a.models,
          configOptions: a.configOptions,
          authMethods: a.authMethods,
          commands: a.commands,
          canConfigureProviders: a.canConfigureProviders,
        })),
        activeAgentId,
      }),
    );
    localStorage.removeItem(LEGACY_AGENT_PERSIST_KEY);
  } catch {
    /* storage unavailable / quota exceeded — non-fatal */
  }
}

const persistedAgent = loadPersistedAgent();
let legacyTranscriptPending = persistedAgent.agentSessions.some(
  (thread) => thread.items.length > 0,
);
let transcriptPersistenceEnabled = false;

const DEBUG_BREAKPOINTS_KEY = "logos.debug.breakpoints.v1";

function loadPersistedBreakpoints(): Record<string, DebugBreakpointState[]> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(DEBUG_BREAKPOINTS_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, DebugBreakpointState[]>).map(
        ([sourcePath, breakpoints]) => [
          sourcePath,
          breakpoints.map(
            ({
              id,
              line,
              column,
              condition,
              hitCondition,
              logMessage,
            }) => ({
              id: typeof id === "string" ? id : crypto.randomUUID(),
              line,
              ...(column == null ? {} : { column }),
              ...(condition ? { condition } : {}),
              ...(hitCondition ? { hitCondition } : {}),
              ...(logMessage ? { logMessage } : {}),
            }),
          ),
        ],
      ),
    );
  } catch {
    return {};
  }
}

function persistBreakpoints(
  breakpoints: Record<string, DebugBreakpointState[]>,
): void {
  try {
    localStorage.setItem(
      DEBUG_BREAKPOINTS_KEY,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(breakpoints).map(([sourcePath, sourceBreakpoints]) => [
            sourcePath,
            sourceBreakpoints
              .filter((breakpoint) => !breakpoint.adapterCreated)
              .map(
                ({
                  id,
                  line,
                  column,
                  condition,
                  hitCondition,
                  logMessage,
                }) => ({
                  id,
                  line,
                  ...(column == null ? {} : { column }),
                  ...(condition ? { condition } : {}),
                  ...(hitCondition ? { hitCondition } : {}),
                  ...(logMessage ? { logMessage } : {}),
                }),
              ),
          ]),
        ),
      ),
    );
  } catch {
    /* storage unavailable — breakpoints remain valid for this session */
  }
}

function initialDebugState(): DebugViewState {
  return {
    sessions: {},
    activeSessionId: null,
    adapters: [],
    configurations: [],
    configurationPath: null,
    configurationError: null,
    breakpoints: loadPersistedBreakpoints(),
    threads: [],
    selectedThreadId: null,
    stackFrames: [],
    selectedFrameId: null,
    scopes: [],
    variables: {},
    console: [],
    stoppedReason: null,
    pausedSessionId: null,
    pauseGeneration: 0,
  };
}

function isCurrentDebugPause(
  debug: DebugViewState,
  sessionId: string,
  generation: number,
): boolean {
  return (
    debug.activeSessionId === sessionId &&
    debug.pausedSessionId === sessionId &&
    debug.pauseGeneration === generation
  );
}

function consoleEntry(
  category: DebugConsoleEntry["category"],
  output: string,
  details: Partial<DebugConsoleEntry> = {},
): DebugConsoleEntry {
  return {
    id: `debug-console-${nextDebugConsoleId++}`,
    category,
    output,
    ...details,
  };
}

function appendDebugError(debug: DebugViewState, error: unknown): DebugViewState {
  return {
    ...debug,
    console: [
      ...debug.console,
      consoleEntry(
        "error",
        `${error instanceof Error ? error.message : String(error)}\n`,
      ),
    ].slice(-2_000),
  };
}

function dapBreakpoints(
  breakpoints: Record<string, DebugBreakpointState[]>,
): Record<string, DapSourceBreakpoint[]> {
  return Object.fromEntries(
    Object.entries(breakpoints).map(([sourcePath, sourceBreakpoints]) => [
      sourcePath,
      dapSourceBreakpoints(sourceBreakpoints),
    ]),
  );
}

function dapSourceBreakpoints(
  breakpoints: DebugBreakpointState[],
): DapSourceBreakpoint[] {
  return breakpoints
    .filter((breakpoint) => !breakpoint.adapterCreated)
    .map(({ line, column, condition, hitCondition, logMessage }) => ({
      line,
      ...(column == null ? {} : { column }),
      ...(condition ? { condition } : {}),
      ...(hitCondition ? { hitCondition } : {}),
      ...(logMessage ? { logMessage } : {}),
    }));
}

function pathIsInWorkspace(sourcePath: string, root: string | null): boolean {
  if (!root) return false;
  const workspace = root.replace(/[/\\]+$/, "");
  return (
    sourcePath === workspace ||
    sourcePath.startsWith(`${workspace}/`) ||
    sourcePath.startsWith(`${workspace}\\`)
  );
}

function clearDebugSourcePositions(
  tabs: EditorTab[],
  sessionId: string,
): EditorTab[] {
  return tabs.map((tab) =>
    tab.debugSessionId === sessionId && tab.debugPosition
      ? { ...tab, debugPosition: undefined }
      : tab,
  );
}

export const useStore = create<LogosState>((set, get) => ({
  ready: false,
  settings: { ...DEFAULT_SETTINGS },
  root: null,
  recent: [],

  sidebarView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 260,
  secondaryVisible: true,
  secondaryWidth: 360,
  panelVisible: false,
  panelTab: "terminal",
  panelHeight: 240,

  tabs: [makeWelcomeTab()],
  activeTabId: "welcome",
  cursor: { line: 1, col: 1 },

  terminals: [],
  activeTerminalId: null,

  git: null,
  gitHead: null,
  currentLineBlame: null,
  diagnostics: {},
  lsp: {},
  lspLogs: [],
  lspWorkDone: {},

  debug: initialDebugState(),

  agentSessions: persistedAgent.agentSessions,
  activeAgentId: persistedAgent.activeAgentId,
  agentModels: [],
  agentCommands: [],
  agentRegistry: [],
  agentCredentialStatus: { type: "none" },

  paletteOpen: false,

  async bootstrap() {
    const [settings, root, recent, servers, debugSessions, debugAdapters] =
      await Promise.all([
        window.logos.settings.getAll(),
        window.logos.workspace.getRoot(),
        window.logos.workspace.recent(),
        window.logos.lsp.list().catch(() => []),
        window.logos.debug.list().catch(() => []),
        window.logos.debug.listAdapters().catch(() => []),
      ]);
    const lsp: Record<string, LspProgress> = {};
    for (const s of servers)
      lsp[s.id] = { id: s.id, status: s.status, message: s.message };
    const sessions = Object.fromEntries(
      debugSessions.map((session) => [session.id, session]),
    );
    set((state) => ({
      settings,
      root,
      recent,
      lsp,
      debug: {
        ...state.debug,
        sessions,
        activeSessionId: debugSessions.at(-1)?.id ?? null,
        adapters: debugAdapters,
      },
      ready: true,
    }));

    window.logos.settings.onChanged((s) => set({ settings: s }));
    window.logos.workspace.onChanged((r) => {
      set({ root: r });
      void get().refreshGit();
      void get().loadDebugConfigurations();
    });
    window.logos.agent.onEvent((e) => get().applyAgentEvent(e));
    window.logos.debug.onEvent((event) => get().applyDebugEvent(event));
    // C1: the single store-side LSP status subscriber (status bar + Extensions
    // view both read this slice). lsp-monaco keeps its own subscriber for the
    // Monaco-side self-heal.
    window.logos.lsp.onProgress((p) => get().setLspProgress(p));
    window.logos.lsp.onLog((entry) => get().appendLspLog(entry));

    // Always have at least one agent session ready (the Cursor layout shows it).
    if (get().agentSessions.length === 0) get().newAgentSession("Agent 1");
    void get().loadAgentRegistry();
    void get().refreshAgentAuth();
    if (root) void get().refreshGit();
    void get().loadDebugConfigurations();
  },

  async setSetting(key, value) {
    set((state) => ({ settings: { ...state.settings, [key]: value } }));
    try {
      const settings = await window.logos.settings.set(key, value);
      set({ settings });
    } catch (error) {
      set({ settings: await window.logos.settings.getAll() });
      throw error;
    }
  },
  async setManySettings(patch) {
    const rendererPatch = patch["agent.acpServers"]
      ? {
          ...patch,
          "agent.acpServers": patch["agent.acpServers"].map((server) => ({
            ...server,
            env: Object.fromEntries(
              Object.entries(server.env).filter(
                ([name]) => !isSensitiveEnvName(name),
              ),
            ),
          })),
        }
      : patch;
    set((state) => ({ settings: { ...state.settings, ...rendererPatch } }));
    try {
      const settings = await window.logos.settings.setMany(patch);
      set({ settings });
    } catch (error) {
      set({ settings: await window.logos.settings.getAll() });
      throw error;
    }
  },
  async resetSettings() {
    const s = await window.logos.settings.reset();
    set({ settings: s });
  },
  toggleLayout() {
    const next: LayoutMode =
      get().settings["workbench.layout"] === "vscode" ? "cursor" : "vscode";
    void get().setSetting("workbench.layout", next);
  },
  toggleTheme() {
    const next: ThemeMode =
      get().settings["workbench.theme"] === "dark" ? "light" : "dark";
    void get().setSetting("workbench.theme", next);
  },
  toggleLanguage() {
    const next: LanguageCode =
      get().settings["workbench.language"] === "en" ? "zh" : "en";
    void get().setSetting("workbench.language", next);
  },

  async openFolder() {
    const path = await window.logos.dialog.openFolder();
    if (path) await get().setRoot(path);
  },
  async setRoot(path) {
    await window.logos.workspace.setRoot(path);
    const recent = await window.logos.workspace.recent();
    set({ root: path, recent });
    await get().refreshGit();
    await get().loadDebugConfigurations();
  },

  openFile(path) {
    const id = `file:${path}`;
    const existing = get().tabs.find((t) => t.id === id);
    if (existing) {
      set({ activeTabId: id });
      return;
    }
    const tab: EditorTab = {
      id,
      kind: "file",
      name: basename(path),
      path,
      language: languageFromPath(path),
      dirty: false,
    };
    set((s) => ({
      tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab],
      activeTabId: id,
    }));
  },
  openGitDiff(path, staged) {
    const root = get().root;
    if (!root) return;
    const id = `diff:${staged ? "index" : "worktree"}:${path}`;
    const tab: EditorTab = {
      id,
      kind: "diff",
      name: `${basename(path)} (${staged ? "Index" : "Working Tree"})`,
      path: `${root}/${path}`,
      language: languageFromPath(path),
      diff: { path, staged },
    };
    set((state) => ({
      tabs: state.tabs.some((item) => item.id === id)
        ? state.tabs
        : [...state.tabs.filter((item) => item.kind !== "welcome"), tab],
      activeTabId: id,
    }));
  },
  openSpecial(kind) {
    const id = kind;
    const names: Record<string, string> = {
      settings: "Settings",
      extensions: "Language Servers",
      welcome: "Welcome",
    };
    if (!get().tabs.find((t) => t.id === id)) {
      set((s) => ({
        tabs: [...s.tabs, { id, kind, name: names[kind] }],
      }));
    }
    set({ activeTabId: id });
  },
  openPreview(path) {
    const id = `preview:${path}`;
    if (!get().tabs.find((t) => t.id === id)) {
      set((s) => ({
        tabs: [
          ...s.tabs,
          { id, kind: "preview", name: `Preview ${basename(path)}`, path },
        ],
      }));
    }
    set({ activeTabId: id });
  },
  openWebview(url, name) {
    const id = `webview:${url}`;
    if (!get().tabs.find((t) => t.id === id)) {
      set((s) => ({
        tabs: [...s.tabs, { id, kind: "webview", name, url }],
      }));
    }
    set({ activeTabId: id });
  },
  closeTab(id) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        const fallback = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1];
        activeTabId = fallback?.id ?? null;
      }
      if (tabs.length === 0) {
        const welcome = makeWelcomeTab();
        return { tabs: [welcome], activeTabId: welcome.id };
      }
      return { tabs, activeTabId };
    });
  },
  setActiveTab(id) {
    set({ activeTabId: id });
  },
  setDirty(id, dirty) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
    }));
  },
  setCursor(line, col) {
    set({ cursor: { line, col } });
  },

  setSidebarView(v) {
    const s = get();
    // Clicking the active view toggles the sidebar, like VS Code.
    if (s.sidebarView === v && s.sidebarVisible) set({ sidebarVisible: false });
    else set({ sidebarView: v, sidebarVisible: true });
  },
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }));
  },
  toggleSecondary() {
    set((s) => ({ secondaryVisible: !s.secondaryVisible }));
  },
  togglePanel() {
    set((s) => ({ panelVisible: !s.panelVisible }));
  },
  setPanelTab(t) {
    set({ panelTab: t, panelVisible: true });
  },
  setSidebarWidth(w) {
    set({ sidebarWidth: Math.max(160, Math.min(560, w)) });
  },
  setSecondaryWidth(w) {
    set({ secondaryWidth: Math.max(240, Math.min(720, w)) });
  },
  setPanelHeight(h) {
    set({ panelHeight: Math.max(120, Math.min(720, h)) });
  },

  async newTerminal(options = {}) {
    const created = await window.logos.terminal.create({
      cwd: get().root ?? undefined,
      ...options,
    });
    const inst: TerminalInstance = {
      id: created.id,
      name: `${options.executable ? basename(options.executable) : basename(created.shell)} ${get().terminals.length + 1}`,
      pid: created.pid,
    };
    set((s) => ({
      terminals: [...s.terminals, inst],
      activeTerminalId: inst.id,
      panelVisible: true,
      panelTab: "terminal",
    }));
  },
  closeTerminal(id) {
    window.logos.terminal.kill(id);
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id);
      const activeTerminalId =
        s.activeTerminalId === id
          ? (terminals[terminals.length - 1]?.id ?? null)
          : s.activeTerminalId;
      return { terminals, activeTerminalId };
    });
  },
  setActiveTerminal(id) {
    set({ activeTerminalId: id });
  },

  async refreshGit() {
    const root = get().root;
    if (!root) {
      set({ git: null, gitHead: null });
      return;
    }
    try {
      const [git, gitHead] = await Promise.all([
        window.logos.git.status(root),
        window.logos.git.head(root).catch(() => null),
      ]);
      set({ git, gitHead });
    } catch {
      set({ git: null, gitHead: null });
    }
  },
  async gitFetch() {
    const root = get().root;
    if (!root) return;
    notifyResult(await window.logos.git.fetch(root), "Fetched");
    await get().refreshGit();
  },
  async gitPull() {
    const root = get().root;
    if (!root) return;
    notifyResult(await window.logos.git.pull(root), "Pulled");
    await get().refreshGit();
  },
  async gitPush() {
    const root = get().root;
    if (!root) return;
    notifyResult(await window.logos.git.push(root), "Pushed");
    await get().refreshGit();
  },
  async gitSync() {
    const root = get().root;
    if (!root) return;
    notifyResult(await window.logos.git.sync(root), "Synced");
    await get().refreshGit();
  },
  setCurrentLineBlame(currentLineBlame) {
    set({ currentLineBlame });
  },
  setDiagnostics(path, diags) {
    set((s) => ({ diagnostics: { ...s.diagnostics, [path]: diags } }));
  },
  setLspProgress(p) {
    set((s) => ({ lsp: { ...s.lsp, [p.id]: p } }));
  },
  appendLspLog(entry) {
    const log: StoredLspLog = { ...entry, id: nextLspLogId++ };
    set((s) => ({ lspLogs: [...s.lspLogs, log].slice(-1000) }));
  },
  clearLspLogs() {
    set({ lspLogs: [] });
  },
  setLspWorkDone(progress) {
    const key = `${progress.serverId}:${typeof progress.token}:${progress.token}`;
    set((state) => ({
      lspWorkDone: { ...state.lspWorkDone, [key]: progress },
    }));
  },
  clearLspWorkDone(serverId, token) {
    const key = `${serverId}:${typeof token}:${token}`;
    set((state) => {
      const lspWorkDone = { ...state.lspWorkDone };
      delete lspWorkDone[key];
      return { lspWorkDone };
    });
  },
  async loadAgentModels() {
    if (get().agentModels.length) return; // cache: fetch once per run
    const models = await window.logos.agent
      .listModels(agentAuthCtx(get()))
      .catch(() => []);
    if (models.length) set({ agentModels: models });
  },
  async loadAgentCommands() {
    const commands = await window.logos.agent
      .listCommands(agentAuthCtx(get()))
      .catch(() => []);
    set({ agentCommands: commands });
  },
  async loadAgentRegistry(forceRefresh) {
    try {
      const agents = await window.logos.agent.listRegistry(forceRefresh);
      set({ agentRegistry: agents });
    } catch {
      // Keep the last successful registry when refresh fails.
    }
  },
  async refreshAgentAuth() {
    const status = await window.logos.agent.authStatus();
    set({ agentCredentialStatus: status });
  },
  async loginChatGPT() {
    const status = await window.logos.agent.loginChatGPT();
    set({ agentCredentialStatus: status });
  },
  async setOpenAIKey(apiKey) {
    const status = await window.logos.agent.setOpenAIKey(apiKey);
    set({ agentCredentialStatus: status });
  },
  async logoutOpenAI() {
    await window.logos.agent.logoutOpenAI();
    set({ agentCredentialStatus: { type: "none" } });
  },

  async loadDebugConfigurations() {
    const requestVersion = ++debugConfigurationRequestVersion;
    const root = get().root;
    if (!root) {
      if (debugConfigurationRequestVersion !== requestVersion) return;
      set((state) => ({
        debug: {
          ...state.debug,
          configurations: [],
          configurationPath: null,
          configurationError: null,
        },
      }));
      return;
    }
    const candidates = [
      `${root}/.logos/launch.json`,
      `${root}/.vscode/launch.json`,
    ];
    const configurationPath =
      (await Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          exists: await window.logos.fs.exists(candidate).catch(() => false),
        })),
      )).find((entry) => entry.exists)?.candidate ?? null;
    if (debugConfigurationRequestVersion !== requestVersion) return;
    if (!configurationPath) {
      set((state) => ({
        debug: {
          ...state.debug,
          configurations: [],
          configurationPath: null,
          configurationError: null,
        },
      }));
      return;
    }
    try {
      const source = await window.logos.fs.readFile(configurationPath);
      const file = parseDebugConfigurationFile(source);
      if (debugConfigurationRequestVersion !== requestVersion) return;
      set((state) => ({
        debug: {
          ...state.debug,
          configurations: file.configurations,
          configurationPath,
          configurationError: null,
        },
      }));
    } catch (error) {
      if (debugConfigurationRequestVersion !== requestVersion) return;
      set((state) => ({
        debug: {
          ...state.debug,
          configurations: [],
          configurationPath,
          configurationError:
            error instanceof Error ? error.message : String(error),
        },
      }));
    }
  },
  async createDebugConfiguration() {
    const root = get().root;
    if (!root) return;
    const directory = `${root}/.logos`;
    const configurationPath = `${directory}/launch.json`;
    if (!(await window.logos.fs.exists(directory))) {
      await window.logos.fs.createDir(directory);
    }
    if (!(await window.logos.fs.exists(configurationPath))) {
      await window.logos.fs.createFile(
        configurationPath,
        DEFAULT_DEBUG_CONFIGURATION,
      );
    }
    await get().loadDebugConfigurations();
    get().openFile(configurationPath);
  },
  async startDebug(configuration) {
    const state = get();
    const selected = configuration ?? state.debug.configurations[0];
    if (!selected) {
      await get().createDebugConfiguration();
      return;
    }
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    const sessionId = crypto.randomUUID();
    debugVariablePages.clear();
    const resolved = resolveDebugConfiguration(selected, {
      workspaceFolder: state.root ?? ".",
      file: active?.kind === "file" ? active.path : undefined,
    });
    const pending: DebugSessionInfo = {
      id: sessionId,
      name: resolved.name,
      debugType: resolved.type,
      request: resolved.request,
      status: "initializing",
      capabilities: {},
    };
    set((current) => ({
      sidebarView: "debug",
      sidebarVisible: true,
      debug: {
        ...current.debug,
        sessions: { ...current.debug.sessions, [sessionId]: pending },
        activeSessionId: sessionId,
        threads: [],
        selectedThreadId: null,
        stackFrames: [],
        selectedFrameId: null,
        scopes: [],
        variables: {},
        stoppedReason: null,
        pausedSessionId: null,
        pauseGeneration: current.debug.pauseGeneration + 1,
        console: [
          ...current.debug.console,
          consoleEntry("console", `Starting ${resolved.name}…\n`),
        ],
      },
    }));
    try {
      await window.logos.debug.start({
        sessionId,
        configuration: resolved,
        initialBreakpoints: dapBreakpoints(
          Object.fromEntries(
            Object.entries(get().debug.breakpoints).filter(([sourcePath]) =>
              pathIsInWorkspace(sourcePath, state.root),
            ),
          ),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((current) => {
        const output = `${message}\n`;
        return {
          panelVisible: true,
          panelTab: "debug",
          debug: {
            ...current.debug,
            sessions: {
              ...current.debug.sessions,
              [sessionId]: {
                ...(current.debug.sessions[sessionId] ?? pending),
                status: "error",
                message,
              },
            },
            console:
              current.debug.console.at(-1)?.output === output
                ? current.debug.console
                : [...current.debug.console, consoleEntry("error", output)],
          },
        };
      });
    }
  },
  async stopDebug() {
    const debug = get().debug;
    let sessionId = debug.activeSessionId;
    const visited = new Set<string>();
    while (sessionId && !visited.has(sessionId)) {
      visited.add(sessionId);
      const parentSessionId = debug.sessions[sessionId]?.parentSessionId;
      if (!parentSessionId) break;
      sessionId = parentSessionId;
    }
    if (sessionId) {
      const terminateDebuggee = debug.sessions[sessionId]?.request === "launch";
      await window.logos.debug.stop(sessionId, terminateDebuggee);
    }
  },
  async debugContinue() {
    const debug = get().debug;
    if (!debug.activeSessionId || debug.selectedThreadId == null) return;
    try {
      await window.logos.debug.request(debug.activeSessionId, "continue", {
        threadId: debug.selectedThreadId,
      });
    } catch (error) {
      set((state) => ({ debug: appendDebugError(state.debug, error) }));
    }
  },
  async debugPause() {
    const debug = get().debug;
    if (!debug.activeSessionId) return;
    try {
      let threadId = debug.selectedThreadId ?? debug.threads[0]?.id;
      if (threadId == null) {
        const response = await window.logos.debug.request<{
          threads?: DapThread[];
        }>(debug.activeSessionId, "threads");
        const threads = response.body?.threads ?? [];
        if (get().debug.activeSessionId !== debug.activeSessionId) return;
        threadId = threads[0]?.id;
        set((state) => ({
          debug: { ...state.debug, threads },
        }));
      }
      if (threadId == null) return;
      await window.logos.debug.request(debug.activeSessionId, "pause", {
        threadId,
      });
    } catch (error) {
      set((state) => ({ debug: appendDebugError(state.debug, error) }));
    }
  },
  async debugStep(command) {
    const debug = get().debug;
    if (!debug.activeSessionId || debug.selectedThreadId == null) return;
    const session = debug.sessions[debug.activeSessionId];
    try {
      await window.logos.debug.request(debug.activeSessionId, command, {
        threadId: debug.selectedThreadId,
        ...(session?.capabilities.supportsSteppingGranularity
          ? { granularity: "statement" }
          : {}),
      });
    } catch (error) {
      set((state) => ({ debug: appendDebugError(state.debug, error) }));
    }
  },
  async toggleBreakpoint(sourcePath, line) {
    const requestKey = sourcePath;
    const requestVersion =
      (debugBreakpointRequestVersions.get(requestKey) ?? 0) + 1;
    debugBreakpointRequestVersions.set(requestKey, requestVersion);
    const current = get().debug.breakpoints[sourcePath] ?? [];
    const existing = current.find((breakpoint) => breakpoint.line === line);
    const next = existing
      ? current.filter((breakpoint) => breakpoint.id !== existing.id)
      : [
          ...current,
          {
            id: crypto.randomUUID(),
            line,
          } satisfies DebugBreakpointState,
        ].sort((a, b) => a.line - b.line);
    set((state) => ({
      debug: {
        ...state.debug,
        breakpoints: { ...state.debug.breakpoints, [sourcePath]: next },
      },
    }));
    persistBreakpoints(get().debug.breakpoints);

    const debug = get().debug;
    const session = debug.activeSessionId
      ? debug.sessions[debug.activeSessionId]
      : undefined;
    if (
      !debug.activeSessionId ||
      !session ||
      session.status === "terminated" ||
      session.status === "error"
    ) return;
    const requestedBreakpoints = next.filter(
      (breakpoint) => !breakpoint.adapterCreated,
    );
    try {
      const protocolBreakpoints = await window.logos.debug.setBreakpoints(
        debug.activeSessionId,
        sourcePath,
        dapSourceBreakpoints(next),
      );
      if (debugBreakpointRequestVersions.get(requestKey) !== requestVersion) {
        return;
      }
      set((state) => ({
        debug: {
          ...state.debug,
          breakpoints: {
            ...state.debug.breakpoints,
            [sourcePath]: (
              state.debug.breakpoints[sourcePath] ?? []
            ).map((breakpoint) => {
              const index = requestedBreakpoints.findIndex(
                (item) => item.id === breakpoint.id,
              );
              if (index < 0) return breakpoint;
              return {
                ...breakpoint,
                sessionData: {
                  ...breakpoint.sessionData,
                  [debug.activeSessionId!]: protocolBreakpoints[index] ?? {
                    verified: false,
                  },
                },
              };
            }),
          },
        },
      }));
    } catch (error) {
      set((state) => ({ debug: appendDebugError(state.debug, error) }));
    }
  },
  async selectDebugThread(threadId) {
    const debug = get().debug;
    const sessionId = debug.activeSessionId;
    if (!sessionId || debug.pausedSessionId !== sessionId) return;
    const generation = debug.pauseGeneration;
    const requestId = nextDebugThreadRequestId++;
    activeDebugThreadRequestId = requestId;
    set((state) => ({
      debug: {
        ...state.debug,
        selectedThreadId: threadId,
        stackFrames: [],
        selectedFrameId: null,
        scopes: [],
        variables: {},
      },
    }));
    try {
      const response = await window.logos.debug.request<{
        stackFrames?: DapStackFrame[];
      }>(sessionId, "stackTrace", { threadId });
      const stackFrames = response.body?.stackFrames ?? [];
      if (
        activeDebugThreadRequestId !== requestId ||
        !isCurrentDebugPause(get().debug, sessionId, generation) ||
        get().debug.selectedThreadId !== threadId
      ) {
        return;
      }
      set((state) => ({
        debug: {
          ...state.debug,
          stackFrames,
          selectedFrameId: stackFrames[0]?.id ?? null,
          scopes: [],
          variables: {},
        },
      }));
      if (stackFrames[0]) await get().selectDebugFrame(stackFrames[0].id);
    } catch (error) {
      if (
        activeDebugThreadRequestId !== requestId ||
        !isCurrentDebugPause(get().debug, sessionId, generation)
      ) {
        return;
      }
      set((state) => ({ debug: appendDebugError(state.debug, error) }));
    }
  },
  async selectDebugFrame(frameId) {
    const debug = get().debug;
    const sessionId = debug.activeSessionId;
    if (!sessionId || debug.pausedSessionId !== sessionId) return;
    const generation = debug.pauseGeneration;
    const requestId = nextDebugFrameRequestId++;
    activeDebugFrameRequestId = requestId;
    const frame = debug.stackFrames.find((item) => item.id === frameId);
    if (!frame) return;
    set((state) => ({
      debug: {
        ...state.debug,
        selectedFrameId: frameId,
        scopes: [],
        variables: {},
      },
    }));
    if (frame.source?.sourceReference) {
      const source = frame.source;
      void window.logos.debug
        .request<{ content?: string; mimeType?: string }>(sessionId, "source", {
          source,
          sourceReference: source.sourceReference,
        })
        .then((response) => {
          if (
            activeDebugFrameRequestId !== requestId ||
            !isCurrentDebugPause(get().debug, sessionId, generation) ||
            get().debug.selectedFrameId !== frameId
          ) {
            return;
          }
          const id = `debug-source:${sessionId}:${source.sourceReference}`;
          const name =
            source.name ||
            (source.path ? basename(source.path) : undefined) ||
            `Source ${source.sourceReference}`;
          const tab: EditorTab = {
            id,
            kind: "debug-source",
            name,
            path: id,
            language: languageFromPath(name),
            content: response.body?.content ?? "",
            debugSessionId: sessionId,
            debugPosition: {
              line: Math.max(frame.line, 1),
              column: Math.max(frame.column, 1),
            },
          };
          set((state) => ({
            tabs: [...state.tabs.filter((item) => item.id !== id), tab],
            activeTabId: id,
          }));
        })
        .catch(() => undefined);
    } else if (frame.source?.path) {
      get().openFile(frame.source.path);
    }
    try {
      const response = await window.logos.debug.request<{ scopes?: DapScope[] }>(
        sessionId,
        "scopes",
        { frameId },
      );
      const scopes = response.body?.scopes ?? [];
      if (
        activeDebugFrameRequestId !== requestId ||
        !isCurrentDebugPause(get().debug, sessionId, generation) ||
        get().debug.selectedFrameId !== frameId
      ) {
        return;
      }
      set((state) => ({
        debug: { ...state.debug, scopes },
      }));
      await Promise.all(
        scopes
          .filter((scope) => !scope.expensive)
          .map((scope) => get().loadDebugVariables(scope.variablesReference)),
      );
    } catch (error) {
      if (
        activeDebugFrameRequestId !== requestId ||
        !isCurrentDebugPause(get().debug, sessionId, generation)
      ) {
        return;
      }
      set((state) => ({ debug: appendDebugError(state.debug, error) }));
    }
  },
  async loadDebugVariables(reference) {
    if (!reference) return;
    const debug = get().debug;
    const sessionId = debug.activeSessionId;
    if (!sessionId || debug.pausedSessionId !== sessionId) return;
    const generation = debug.pauseGeneration;
    const frameId = debug.selectedFrameId;
    const page = debugVariablePages.get(reference);
    const container = page
      ? undefined
      : [
          ...debug.scopes,
          ...Object.values(debug.variables).flat(),
        ].find((item) => item.variablesReference === reference);
    const chunks: DapVariable[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const addPageLevel = (
      filter: "indexed" | "named",
      first: number,
      total: number,
    ) => {
      let chunkSize = 100;
      while (Math.ceil(total / chunkSize) > 100) chunkSize *= 100;
      for (let offset = 0; offset < total; offset += chunkSize) {
        const count = Math.min(chunkSize, total - offset);
        const start = first + offset;
        const pageReference = nextDebugVariablePageReference--;
        debugVariablePages.set(pageReference, {
          reference: page?.reference ?? reference,
          filter,
          start,
          count,
        });
        chunks.push({
          name:
            filter === "indexed"
              ? `[${start}..${start + count - 1}]`
              : `named[${start}..${start + count - 1}]`,
          value: "",
          variablesReference: pageReference,
          ...(filter === "indexed"
            ? { indexedVariables: count }
            : { namedVariables: count }),
          presentationHint: { kind: "virtual" },
        });
      }
    };
    if (page) {
      if (page.count > 100) {
        addPageLevel(page.filter, page.start, page.count);
      } else {
        requests.push({
          variablesReference: page.reference,
          filter: page.filter,
          start: page.start,
          count: page.count,
        });
      }
    } else if (
      container &&
      (container.indexedVariables != null || container.namedVariables != null)
    ) {
      if (container.namedVariables === undefined) {
        requests.push({ variablesReference: reference, filter: "named" });
      } else if (container.namedVariables > 100) {
        addPageLevel("named", 0, container.namedVariables);
      } else if (container.namedVariables > 0) {
        requests.push({ variablesReference: reference, filter: "named" });
      }
      if ((container.indexedVariables ?? 0) > 100) {
        addPageLevel("indexed", 0, container.indexedVariables!);
      } else if ((container.indexedVariables ?? 0) > 0) {
        requests.push({ variablesReference: reference, filter: "indexed" });
      }
    } else {
      requests.push({ variablesReference: reference });
    }
    let responses: Array<{ body?: { variables?: DapVariable[] } }>;
    try {
      responses = await Promise.all(
        requests.map((args) =>
          window.logos.debug.request<{ variables?: DapVariable[] }>(
            sessionId,
            "variables",
            args,
          ),
        ),
      );
    } catch (error) {
      if (isCurrentDebugPause(get().debug, sessionId, generation)) {
        set((state) => ({
          debug: {
            ...state.debug,
            console: [
              ...state.debug.console,
              consoleEntry(
                "error",
                `${error instanceof Error ? error.message : String(error)}\n`,
              ),
            ].slice(-2_000),
          },
        }));
      }
      return;
    }
    if (
      !isCurrentDebugPause(get().debug, sessionId, generation) ||
      get().debug.selectedFrameId !== frameId
    ) {
      return;
    }
    set((state) => ({
      debug: {
        ...state.debug,
        variables: {
          ...state.debug.variables,
          [reference]: [
            ...responses.flatMap((response) => response.body?.variables ?? []),
            ...chunks,
          ],
        },
      },
    }));
  },
  async evaluateDebug(expression) {
    const value = expression.trim();
    if (!value) return;
    const debug = get().debug;
    if (!debug.activeSessionId) return;
    set((state) => ({
      debug: {
        ...state.debug,
        console: [
          ...state.debug.console,
          consoleEntry("input", `> ${value}\n`),
        ].slice(-2_000),
      },
    }));
    try {
      const response = await window.logos.debug.request<DapEvaluateResult>(
        debug.activeSessionId,
        "evaluate",
        {
          expression: value,
          context: "repl",
          ...(debug.selectedFrameId == null
            ? {}
            : { frameId: debug.selectedFrameId }),
        },
      );
      const result = response.body;
      set((state) => ({
        debug: {
          ...state.debug,
          console: [
            ...state.debug.console,
            consoleEntry("result", `${result?.result ?? ""}\n`, {
              variablesReference: result?.variablesReference,
            }),
          ].slice(-2_000),
        },
      }));
    } catch (error) {
      set((state) => ({
        debug: {
          ...state.debug,
          console: [
            ...state.debug.console,
            consoleEntry(
              "error",
              `${error instanceof Error ? error.message : String(error)}\n`,
            ),
          ].slice(-2_000),
        },
      }));
    }
  },
  clearDebugConsole() {
    set((state) => ({
      debug: { ...state.debug, console: [] },
    }));
  },
  applyDebugEvent(event) {
    if (event.kind === "session") {
      set((state) => {
        const ended =
          event.session.status === "terminated" ||
          event.session.status === "error";
        const errorOutput = event.session.message
          ? `${event.session.message}\n`
          : null;
        const console =
          event.session.status === "error" &&
          errorOutput &&
          state.debug.console.at(-1)?.output !== errorOutput
            ? [
                ...state.debug.console,
                consoleEntry("error", errorOutput),
              ].slice(-2_000)
            : state.debug.console;
        const sessions: Record<string, DebugSessionInfo> = {
          ...state.debug.sessions,
          [event.session.id]: event.session,
        };
        const removable = Object.values(sessions).filter(
          (session) =>
            session.id !== event.session.id &&
            session.id !== state.debug.activeSessionId &&
            (session.status === "terminated" || session.status === "error"),
        );
        while (Object.keys(sessions).length > 50 && removable.length) {
          const stale = removable.shift();
          if (stale) delete sessions[stale.id];
        }
        const allSessionsEnded = Object.values(sessions).every(
          (session) =>
            session.status === "terminated" || session.status === "error",
        );
        const breakpoints = Object.fromEntries(
          Object.entries(state.debug.breakpoints).map(
            ([sourcePath, sourceBreakpoints]) => [
              sourcePath,
              sourceBreakpoints
                .filter(
                  (breakpoint) =>
                    !(
                      ended &&
                      breakpoint.adapterCreated &&
                      (allSessionsEnded ||
                        breakpoint.sessionData?.[event.session.id])
                    ),
                )
                .map((breakpoint) => {
                  if (allSessionsEnded) {
                    const { sessionData: _sessionData, ...persistent } =
                      breakpoint;
                    return persistent;
                  }
                  if (!ended || !breakpoint.sessionData?.[event.session.id]) {
                    return breakpoint;
                  }
                  const sessionData = { ...breakpoint.sessionData };
                  delete sessionData[event.session.id];
                  return {
                    ...breakpoint,
                    sessionData: Object.keys(sessionData).length
                      ? sessionData
                      : undefined,
                  };
                }),
            ],
          ),
        );
        const fallbackSession = Object.values(sessions).find(
          (session) =>
            session.status !== "terminated" && session.status !== "error",
        );
        const activeSessionId = ended
          ? state.debug.activeSessionId === event.session.id
            ? (fallbackSession?.id ?? null)
            : state.debug.activeSessionId
          : (state.debug.activeSessionId ?? event.session.id);
        const clearPause =
          ended && state.debug.pausedSessionId === event.session.id;
        return {
          ...(ended
            ? { tabs: clearDebugSourcePositions(state.tabs, event.session.id) }
            : {}),
          debug: {
            ...state.debug,
            sessions,
            activeSessionId,
            breakpoints,
            console,
            ...(clearPause
              ? {
                  threads: [],
                  selectedThreadId: null,
                  stackFrames: [],
                  selectedFrameId: null,
                  scopes: [],
                  variables: {},
                  stoppedReason: null,
                  pausedSessionId: null,
                  pauseGeneration: state.debug.pauseGeneration + 1,
                }
              : {}),
          },
        };
      });
      return;
    }
    if (event.kind === "adapter-output") {
      set((state) => ({
        debug: {
          ...state.debug,
          console: [
            ...state.debug.console,
            consoleEntry(event.category, event.output),
          ].slice(-2_000),
        },
      }));
      return;
    }
    if (event.kind === "terminal") {
      set((state) => {
        if (state.terminals.some((terminal) => terminal.id === event.terminal.id)) {
          return state;
        }
        const terminal: TerminalInstance = {
          id: event.terminal.id,
          name:
            event.title ||
            `${basename(event.terminal.shell)} ${state.terminals.length + 1}`,
          pid: event.terminal.pid,
        };
        return {
          terminals: [...state.terminals, terminal],
          activeTerminalId: terminal.id,
          panelVisible: true,
          panelTab: "terminal",
        };
      });
      return;
    }
    if (event.kind === "breakpoints") {
      set((state) => ({
        debug: {
          ...state.debug,
          breakpoints: {
            ...state.debug.breakpoints,
            [event.sourcePath]: (
              state.debug.breakpoints[event.sourcePath] ?? []
            ).map((breakpoint, fallbackIndex) => {
              const requestedIndex = event.requestedBreakpoints.findIndex(
                (requested) =>
                  requested.line === breakpoint.line &&
                  requested.column === breakpoint.column,
              );
              const index = requestedIndex >= 0 ? requestedIndex : fallbackIndex;
              if (requestedIndex < 0 && event.requestedBreakpoints.length) {
                return breakpoint;
              }
              return {
                ...breakpoint,
                sessionData: {
                  ...breakpoint.sessionData,
                  [event.sessionId]: event.breakpoints[index] ?? {
                    verified: false,
                  },
                },
              };
            }),
          },
        },
      }));
      return;
    }

    const dapEvent = event.event;
    if (dapEvent.event === "output") {
      const body = dapEvent.body as DapOutputEventBody | undefined;
      if (body?.output && body.category !== "telemetry") {
        set((state) => ({
          debug: {
            ...state.debug,
            console: [
              ...state.debug.console,
              consoleEntry(body.category ?? "console", body.output, {
                source: body.source,
                line: body.line,
                column: body.column,
                variablesReference: body.variablesReference,
              }),
            ].slice(-2_000),
          },
        }));
      }
    } else if (dapEvent.event === "stopped") {
      const body = dapEvent.body as DapStoppedEventBody | undefined;
      const currentDebug = get().debug;
      if (
        body?.preserveFocusHint &&
        currentDebug.activeSessionId &&
        currentDebug.activeSessionId !== event.sessionId
      ) {
        return;
      }
      debugVariablePages.clear();
      set((state) => ({
        ...(body?.preserveFocusHint
          ? {}
          : { panelVisible: true, panelTab: "debug" as const }),
        debug: {
          ...state.debug,
          activeSessionId: event.sessionId,
          pausedSessionId: event.sessionId,
          pauseGeneration: state.debug.pauseGeneration + 1,
          threads: [],
          selectedThreadId: null,
          stackFrames: [],
          selectedFrameId: null,
          scopes: [],
          variables: {},
          stoppedReason: body?.description ?? body?.reason ?? "stopped",
        },
        tabs: clearDebugSourcePositions(state.tabs, event.sessionId),
      }));
      const generation = get().debug.pauseGeneration;
      void window.logos.debug
        .request<{ threads?: DapThread[] }>(event.sessionId, "threads")
        .then(async (response) => {
          const threads = response.body?.threads ?? [];
          if (!isCurrentDebugPause(get().debug, event.sessionId, generation)) {
            return;
          }
          set((state) => ({
            debug: {
              ...state.debug,
              threads,
              selectedThreadId:
                body?.threadId ?? threads[0]?.id ?? state.debug.selectedThreadId,
            },
          }));
          const threadId = body?.threadId ?? threads[0]?.id;
          if (threadId != null) await get().selectDebugThread(threadId);
        })
        .catch((error) => {
          if (!isCurrentDebugPause(get().debug, event.sessionId, generation)) {
            return;
          }
          set((state) => ({ debug: appendDebugError(state.debug, error) }));
        });
    } else if (dapEvent.event === "continued") {
      const body = dapEvent.body as DapContinuedEventBody | undefined;
      set((state) => {
        if (state.debug.pausedSessionId !== event.sessionId) return state;
        const allThreadsContinued = body?.allThreadsContinued !== false;
        if (
          !allThreadsContinued &&
          body?.threadId !== state.debug.selectedThreadId
        ) {
          return state;
        }
        activeDebugThreadRequestId = nextDebugThreadRequestId++;
        activeDebugFrameRequestId = nextDebugFrameRequestId++;
        debugVariablePages.clear();
        return {
          tabs: clearDebugSourcePositions(state.tabs, event.sessionId),
          debug: {
            ...state.debug,
            ...(allThreadsContinued
              ? { threads: [], pausedSessionId: null }
              : {}),
            selectedThreadId: null,
            stackFrames: [],
            selectedFrameId: null,
            scopes: [],
            variables: {},
            stoppedReason: allThreadsContinued
              ? null
              : state.debug.stoppedReason,
            pauseGeneration: state.debug.pauseGeneration + 1,
          },
        };
      });
    } else if (dapEvent.event === "thread") {
      const session = get().debug.sessions[event.sessionId];
      if (session?.status === "stopped") {
        const generation = get().debug.pauseGeneration;
        void window.logos.debug
          .request<{ threads?: DapThread[] }>(event.sessionId, "threads")
          .then((response) =>
            isCurrentDebugPause(get().debug, event.sessionId, generation)
              ? set((state) => ({
                  debug: {
                    ...state.debug,
                    threads: response.body?.threads ?? [],
                  },
                }))
              : undefined,
          )
          .catch(() => undefined);
      }
    } else if (dapEvent.event === "breakpoint") {
      const body = dapEvent.body as
        | { reason?: string; breakpoint?: DapBreakpoint }
        | undefined;
      const protocolBreakpoint = body?.breakpoint;
      if (!protocolBreakpoint) return;
      set((state) => {
        const breakpoints = Object.fromEntries(
          Object.entries(state.debug.breakpoints).map(
            ([sourcePath, sourceBreakpoints]) => [sourcePath, [...sourceBreakpoints]],
          ),
        );
        let matchedPath: string | undefined;
        let matchedIndex = -1;
        for (const [sourcePath, sourceBreakpoints] of Object.entries(breakpoints)) {
          const index = sourceBreakpoints.findIndex((breakpoint) => {
            const sessionData = breakpoint.sessionData?.[event.sessionId];
            if (protocolBreakpoint.id != null) {
              return sessionData?.id === protocolBreakpoint.id;
            }
            return (
              protocolBreakpoint.source?.path === sourcePath &&
              protocolBreakpoint.line != null &&
              (sessionData?.line === protocolBreakpoint.line ||
                breakpoint.line === protocolBreakpoint.line)
            );
          });
          if (index >= 0) {
            matchedPath = sourcePath;
            matchedIndex = index;
            break;
          }
        }

        if (body?.reason === "new") {
          const sourcePath = protocolBreakpoint.source?.path;
          if (!sourcePath || protocolBreakpoint.line == null || matchedPath) {
            return state;
          }
          breakpoints[sourcePath] = [
            ...(breakpoints[sourcePath] ?? []),
            {
              id: crypto.randomUUID(),
              line: protocolBreakpoint.line,
              sessionData: { [event.sessionId]: protocolBreakpoint },
              adapterCreated: true,
            },
          ];
        } else if (body?.reason === "removed") {
          if (!matchedPath || matchedIndex < 0) return state;
          const breakpoint = breakpoints[matchedPath][matchedIndex];
          if (breakpoint.adapterCreated) {
            breakpoints[matchedPath].splice(matchedIndex, 1);
          } else {
            const sessionData = { ...breakpoint.sessionData };
            delete sessionData[event.sessionId];
            breakpoints[matchedPath][matchedIndex] = {
              ...breakpoint,
              sessionData:
                Object.keys(sessionData).length > 0 ? sessionData : undefined,
            };
          }
        } else if (body?.reason === "changed") {
          if (!matchedPath || matchedIndex < 0) return state;
          const breakpoint = breakpoints[matchedPath][matchedIndex];
          breakpoints[matchedPath][matchedIndex] = {
            ...breakpoint,
            sessionData: {
              ...breakpoint.sessionData,
              [event.sessionId]: protocolBreakpoint,
            },
          };
        } else {
          return state;
        }
        persistBreakpoints(breakpoints);
        return { debug: { ...state.debug, breakpoints } };
      });
    }
  },

  newAgentSession(name, parentId, runtimeId) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const selectedRuntime = runtimeId ?? get().settings["agent.defaultRuntime"];
    const session: AgentThread = {
      id,
      name:
        name ??
        (parentId
          ? `Subthread ${get().agentSessions.filter((item) => item.parentId === parentId).length + 1}`
          : `Thread ${get().agentSessions.filter((item) => !item.parentId).length + 1}`),
      items: [],
      status: "idle",
      runtimeId: selectedRuntime,
      workspaceRoot: undefined,
      parentId,
      createdAt: now,
      updatedAt: now,
      followMode: true,
      plan: [],
      modeId:
        selectedRuntime === "claude" || selectedRuntime === "logos"
          ? get().settings["agent.permissionMode"]
          : undefined,
      modes: [],
      models: [],
      configOptions: [],
      authMethods: [],
      commands: [],
      canConfigureProviders: false,
      trace: [],
    };
    set((s) => ({
      agentSessions: [...s.agentSessions, session],
      activeAgentId: id,
    }));
    return id;
  },
  removeAgentSession(id) {
    const state = get();
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of state.agentSessions) {
        if (thread.parentId && removed.has(thread.parentId) && !removed.has(thread.id)) {
          removed.add(thread.id);
          changed = true;
        }
      }
    }
    for (const threadId of removed) void window.logos.agent.close(threadId);
    set((s) => {
      const agentSessions = s.agentSessions.filter((a) => !removed.has(a.id));
      const activeAgentId =
        s.activeAgentId != null && removed.has(s.activeAgentId)
          ? (agentSessions[agentSessions.length - 1]?.id ?? null)
          : s.activeAgentId;
      return { agentSessions, activeAgentId };
    });
  },
  setActiveAgent(id) {
    set({ activeAgentId: id });
  },
  setAgentRuntime(id, runtimeId) {
    set((state) => ({
      agentSessions: state.agentSessions.map((thread) =>
        thread.id === id
          ? {
              ...thread,
              runtimeId,
              runtimeName: undefined,
              workspaceRoot: undefined,
              sdkSessionId: undefined,
              modeId:
                runtimeId === "claude" || runtimeId === "logos"
                  ? state.settings["agent.permissionMode"]
                  : undefined,
              modes: [],
              models: [],
              currentModelId: undefined,
              configOptions: [],
              authMethods: [],
              commands: [],
              canConfigureProviders: false,
              trace: [],
              updatedAt: Date.now(),
            }
          : thread,
      ),
    }));
  },
  async setAgentMode(id, modeId) {
    set((state) => ({
      agentSessions: state.agentSessions.map((thread) =>
        thread.id === id ? { ...thread, modeId, updatedAt: Date.now() } : thread,
      ),
    }));
    await window.logos.agent.setMode(id, modeId).catch(() => undefined);
  },
  async setAgentModel(id, modelId) {
    set((state) => ({
      agentSessions: state.agentSessions.map((thread) =>
        thread.id === id
          ? { ...thread, currentModelId: modelId, updatedAt: Date.now() }
          : thread,
      ),
    }));
    await window.logos.agent.setModel(id, modelId).catch(() => undefined);
  },
  async setAgentConfig(id, configId, value) {
    set((state) => ({
      agentSessions: state.agentSessions.map((thread) => {
        if (thread.id !== id) return thread;
        return {
          ...thread,
          configOptions: thread.configOptions.map((option) =>
            option.id === configId
              ? { ...option, currentValue: value } as AgentConfigOption
              : option,
          ),
          updatedAt: Date.now(),
        };
      }),
    }));
    await window.logos.agent.setConfig({ sessionId: id, configId, value });
  },
  toggleAgentFollow(id) {
    set((state) => ({
      agentSessions: state.agentSessions.map((thread) =>
        thread.id === id
          ? { ...thread, followMode: !thread.followMode, updatedAt: Date.now() }
          : thread,
      ),
    }));
  },
  async authenticateAgent(id, methodId) {
    let result: AgentAuthResult;
    try {
      result = await window.logos.agent.authenticate({
        sessionId: id,
        methodId,
      });
      await get().refreshAgentAuth();
    } catch (error) {
      set((state) => ({
        agentSessions: state.agentSessions.map((thread) =>
          thread.id === id
            ? {
                ...thread,
                status: "waiting",
                items: [
                  ...thread.items,
                  {
                    id: crypto.randomUUID(),
                    kind: "error" as const,
                    message: error instanceof Error ? error.message : String(error),
                  },
                ],
                updatedAt: Date.now(),
              }
            : thread,
        ),
      }));
      return;
    }
    if (!result.terminal) {
      return;
    }
    const created = await window.logos.terminal.create(result.terminal);
    const terminal: TerminalInstance = {
      id: created.id,
      name: `Auth: ${basename(created.shell)}`,
      pid: created.pid,
    };
    set((state) => ({
      terminals: [...state.terminals, terminal],
      activeTerminalId: terminal.id,
      panelVisible: true,
      panelTab: "terminal",
    }));
    const off = window.logos.terminal.onExit(created.id, (code) => {
      off();
      if (code !== 0) return;
      void window.logos.agent
        .authenticate({ sessionId: id, methodId, completed: true })
        .catch((error) => {
          set((state) => ({
            agentSessions: state.agentSessions.map((thread) =>
              thread.id === id
                ? {
                    ...thread,
                    status: "waiting",
                    items: [
                      ...thread.items,
                      {
                        id: crypto.randomUUID(),
                        kind: "error" as const,
                        message:
                          error instanceof Error ? error.message : String(error),
                      },
                    ],
                    updatedAt: Date.now(),
                  }
                : thread,
            ),
          }));
        });
    });
  },
  async sendAgentPrompt(text) {
    let state = get();
    let id = state.activeAgentId;
    if (!id) id = get().newAgentSession();
    state = get();
    const root = state.root ?? ".";
    const s = state.settings;
    // sdkSessionId survives restarts (F2): resume the CLI session if present.
    const session = state.agentSessions.find((a) => a.id === id);
    if (session?.workspaceRoot && session.workspaceRoot !== root) {
      set((current) => ({
        agentSessions: current.agentSessions.map((thread) =>
          thread.id === id
            ? {
                ...thread,
                items: [
                  ...thread.items,
                  {
                    id: crypto.randomUUID(),
                    kind: "error" as const,
                    message: "This thread belongs to a different workspace. Create a new thread to continue.",
                  },
                ],
                updatedAt: Date.now(),
              }
            : thread,
        ),
      }));
      return;
    }
    set((st) => ({
      agentSessions: st.agentSessions.map((a) =>
        a.id === id
          ? {
              ...a,
              status: "running",
              workspaceRoot: a.workspaceRoot ?? root,
              pendingAsk: undefined,
              pendingPermission: undefined,
              items: [
                ...a.items,
                { id: crypto.randomUUID(), kind: "user", text },
              ],
              updatedAt: Date.now(),
            }
          : a,
      ),
    }));
    const allowed = s["agent.allowedTools"];
    const disallowed = s["agent.disallowedTools"];
    let acpServer = s["agent.acpServers"].find(
      (server) => server.id === session?.runtimeId,
    );
    let runtimeResolutionError: string | undefined;
    if (session?.runtimeId.startsWith("registry:")) {
      acpServer = await window.logos.agent
        .resolveRegistryAgent(session.runtimeId.slice("registry:".length))
        .catch((error) => {
          runtimeResolutionError =
            error instanceof Error ? error.message : String(error);
          return undefined;
        });
    }
    if (
      session?.runtimeId &&
      session.runtimeId !== "claude" &&
      session.runtimeId !== "logos" &&
      !acpServer
    ) {
      set((current) => ({
        agentSessions: current.agentSessions.map((thread) =>
          thread.id === id
            ? {
                ...thread,
                status: "idle",
                items: [
                  ...thread.items,
                  {
                    id: crypto.randomUUID(),
                    kind: "error",
                    message:
                      runtimeResolutionError ??
                      `ACP runtime "${thread.runtimeId}" is not configured`,
                  },
                ],
                updatedAt: Date.now(),
              }
            : thread,
        ),
      }));
      return;
    }
    const runtime =
      session?.runtimeId === "logos"
        ? ({ type: "logos" } as const)
        : session?.runtimeId && session.runtimeId !== "claude" && acpServer
          ? ({ type: "acp", server: acpServer } as const)
          : ({ type: "claude" } as const);
    try {
      await window.logos.agent.start({
        sessionId: id!,
        prompt: text,
        cwd: root,
        // `|| undefined` everywhere => "empty means no override", mirroring model.
        model:
          session?.currentModelId ||
          (runtime.type === "logos" ? s["agent.logosModel"] : s["agent.model"]) ||
          undefined,
        permissionMode:
          runtime.type === "claude" || runtime.type === "logos"
            ? ((session?.modeId as Settings["agent.permissionMode"]) ??
              s["agent.permissionMode"])
            : undefined,
        resume: session?.sdkSessionId,
        effort: s["agent.effort"] || undefined,
        thinking: thinkingConfig(s["agent.thinking"], s["agent.thinkingBudget"]),
        allowedTools: allowed.length ? allowed : undefined,
        disallowedTools: disallowed.length ? disallowed : undefined,
        settingSources: s["agent.loadProjectSettings"]
          ? ["user", "project"]
          : undefined,
        apiKey:
          runtime.type === "claude" ? s["agent.apiKey"] || undefined : undefined,
        authToken:
          runtime.type === "claude"
            ? s["agent.authToken"] || undefined
            : undefined,
        baseUrl:
          runtime.type === "logos"
            ? s["agent.openaiBaseUrl"]
            : s["agent.baseUrl"] || undefined,
        runtime,
      });
    } catch (error) {
      const message =
        (error instanceof Error ? error.message : stringifyAgentValue(error)) ||
        "Agent failed to start";
      set((current) => ({
        agentSessions: current.agentSessions.map((thread) =>
          thread.id === id && thread.status === "running"
            ? {
                ...thread,
                status: "idle",
                pendingAsk: undefined,
                pendingPermission: undefined,
                items: [
                  ...thread.items,
                  { id: crypto.randomUUID(), kind: "error", message },
                ],
                updatedAt: Date.now(),
              }
            : thread,
        ),
      }));
    }
  },
  async interruptAgent() {
    const id = get().activeAgentId;
    if (id) {
      await window.logos.agent.interrupt(id);
    }
  },
  async answerAsk(requestId, answers, response, action) {
    await window.logos.agent.respondAsk({ requestId, answers, response, action });
    set((s) => ({
      agentSessions: s.agentSessions.map((a) =>
        a.pendingAsk?.requestId === requestId
          ? {
              ...a,
              pendingAsk: undefined,
              status: "running",
              updatedAt: Date.now(),
            }
          : a,
      ),
    }));
  },
  async respondPermission(requestId, behavior, optionId) {
    await window.logos.agent.respondPermission({ requestId, behavior, optionId });
    set((s) => ({
      agentSessions: s.agentSessions.map((a) =>
        a.pendingPermission?.requestId === requestId
          ? {
              ...a,
              pendingPermission: undefined,
              status: "running",
              updatedAt: Date.now(),
            }
          : a,
      ),
    }));
  },
  applyAgentEvent(e) {
    if (e.kind === "follow") {
      const state = get();
      const thread = state.agentSessions.find((item) => item.id === e.sessionId);
      if (thread?.followMode) {
        const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(e.location.path)
          ? e.location.path
          : state.root
            ? `${state.root}/${e.location.path}`
            : e.location.path;
        get().openFile(absolute);
        if (e.location.line != null) {
          window.dispatchEvent(
            new CustomEvent("logos:lsp-navigate", {
              detail: {
                path: absolute,
                target: { lineNumber: Math.max(e.location.line, 1), column: 1 },
                takeFocus: false,
              },
            }),
          );
        }
      }
      return;
    }
    set((s) => {
      const sessions = s.agentSessions.map((a): AgentThread => {
        if (a.id !== e.sessionId) return a;
        const items = [...a.items];
        const findAssistant = (mid: string) => {
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (it.kind === "assistant" && it.id === mid) return i;
          }
          return -1;
        };
        switch (e.kind) {
          case "system":
            return {
              ...a,
              trace: [
                ...a.trace,
                {
                  id: crypto.randomUUID(),
                  time: Date.now(),
                  subtype: e.subtype,
                  data: agentTraceData(e.data),
                },
              ].slice(-250),
              updatedAt: Date.now(),
            };
          case "text-delta": {
            let idx = findAssistant(e.messageId);
            if (idx === -1) {
              items.push({
                id: e.messageId,
                kind: "assistant",
                text: "",
                thinking: "",
                parentToolUseId: e.parentToolUseId,
              });
              idx = items.length - 1;
            }
            const it = items[idx] as Extract<AgentItem, { kind: "assistant" }>;
            items[idx] = { ...it, text: it.text + e.delta };
            return { ...a, items, updatedAt: Date.now() };
          }
          case "text": {
            const idx = findAssistant(e.messageId);
            if (idx === -1) {
              items.push({
                id: e.messageId,
                kind: "assistant",
                text: e.text,
                thinking: "",
                parentToolUseId: e.parentToolUseId,
              });
            } else {
              const it = items[idx] as Extract<
                AgentItem,
                { kind: "assistant" }
              >;
              items[idx] = { ...it, text: e.text };
            }
            return { ...a, items, updatedAt: Date.now() };
          }
          case "thinking": {
            let idx = findAssistant(e.messageId);
            if (idx === -1) {
              items.push({
                id: e.messageId,
                kind: "assistant",
                text: "",
                thinking: "",
                parentToolUseId: e.parentToolUseId,
              });
              idx = items.length - 1;
            }
            const it = items[idx] as Extract<AgentItem, { kind: "assistant" }>;
            items[idx] = { ...it, thinking: it.thinking + e.delta };
            return { ...a, items, updatedAt: Date.now() };
          }
          case "tool-use":
            items.push({
              id: e.toolUseId,
              kind: "tool",
              toolUseId: e.toolUseId,
              name: e.name,
              input: e.input,
              parentToolUseId: e.parentToolUseId,
              status: e.status,
              toolKind: e.toolKind,
              locations: e.locations,
              diffs: e.diffs,
            });
            return { ...a, items, updatedAt: Date.now() };
          case "tool-result": {
            const idx = items.findIndex(
              (it) => it.kind === "tool" && it.toolUseId === e.toolUseId,
            );
            if (idx !== -1) {
              const it = items[idx] as Extract<AgentItem, { kind: "tool" }>;
              items[idx] = {
                ...it,
                isError: e.isError,
                result: e.content,
                status: e.isError ? "failed" : "completed",
                locations: e.locations ?? it.locations,
                diffs: e.diffs ?? it.diffs,
              };
            }
            return { ...a, items, updatedAt: Date.now() };
          }
          case "tool-update": {
            const idx = items.findIndex(
              (item) => item.kind === "tool" && item.toolUseId === e.toolUseId,
            );
            if (idx === -1) {
              items.push({
                id: e.toolUseId,
                kind: "tool",
                toolUseId: e.toolUseId,
                name: e.title ?? "Tool",
                input: e.input,
                result: e.output == null ? undefined : stringifyAgentValue(e.output),
                status: e.status,
                locations: e.locations,
                diffs: e.diffs,
                isError: e.status === "failed",
              });
            } else {
              const item = items[idx] as Extract<AgentItem, { kind: "tool" }>;
              items[idx] = {
                ...item,
                name: e.title ?? item.name,
                input: e.input ?? item.input,
                result:
                  e.output == null ? item.result : stringifyAgentValue(e.output),
                status: e.status ?? item.status,
                locations: e.locations ?? item.locations,
                diffs: e.diffs ?? item.diffs,
                isError: e.status === "failed" || item.isError,
              };
            }
            return { ...a, items, updatedAt: Date.now() };
          }
          case "subagent": {
            const idx = items.findIndex(
              (item) => item.kind === "subagent" && item.taskId === e.taskId,
            );
            const next: Extract<AgentItem, { kind: "subagent" }> = {
              id: `subagent:${e.taskId}`,
              kind: "subagent",
              taskId: e.taskId,
              toolUseId: e.toolUseId,
              agentType: e.agentType,
              description: e.description,
              status: e.status,
              summary: e.summary,
            };
            if (idx === -1) items.push(next);
            else items[idx] = { ...items[idx], ...next } as AgentItem;
            return { ...a, items, updatedAt: Date.now() };
          }
          case "plan":
            return { ...a, plan: e.entries, updatedAt: Date.now() };
          case "runtime-ready":
            return {
              ...a,
              runtimeName: e.runtimeName,
              sdkSessionId: e.sdkSessionId || a.sdkSessionId,
              modes: e.modes.length ? e.modes : a.modes,
              modeId: e.currentModeId ?? a.modeId,
              models: e.models.length ? e.models : a.models,
              currentModelId: e.currentModelId ?? a.currentModelId,
              configOptions: e.configOptions.length
                ? e.configOptions
                : a.configOptions,
              authMethods: e.authMethods.length ? e.authMethods : a.authMethods,
              commands: e.commands.length ? e.commands : a.commands,
              canConfigureProviders: e.canConfigureProviders,
              status: a.status === "waiting" ? "running" : a.status,
              updatedAt: Date.now(),
            };
          case "mode":
            return { ...a, modeId: e.modeId, updatedAt: Date.now() };
          case "config":
            return { ...a, configOptions: e.options, updatedAt: Date.now() };
          case "session-info":
            return {
              ...a,
              name: e.title || a.name,
              updatedAt: Date.now(),
            };
          case "auth-required":
            return {
              ...a,
              status: "waiting",
              authMethods: e.methods,
              updatedAt: Date.now(),
            };
          case "result":
            items.push({
              id: crypto.randomUUID(),
              kind: "result",
              costUsd: e.costUsd,
              durationMs: e.durationMs,
            });
            // F2: remember the SDK session id so we can resume after restart.
            return {
              ...a,
              items,
              status: "idle",
              sdkSessionId: e.sdkSessionId ?? a.sdkSessionId,
              pendingAsk: undefined,
              pendingPermission: undefined,
              updatedAt: Date.now(),
            };
          case "error":
            items.push({
              id: crypto.randomUUID(),
              kind: "error",
              message: e.message,
            });
            return {
              ...a,
              items,
              status: "idle",
              pendingAsk: undefined,
              pendingPermission: undefined,
              updatedAt: Date.now(),
            };
          case "permission":
            return {
              ...a,
              pendingPermission: {
                requestId: e.requestId,
                toolName: e.toolName,
                input: e.input,
                options: e.options,
              },
              status: "waiting",
              updatedAt: Date.now(),
            };
          case "ask":
            return {
              ...a,
              pendingAsk: { requestId: e.requestId, questions: e.questions },
              status: "waiting",
              updatedAt: Date.now(),
            };
          default:
            return a;
        }
      });
      return { agentSessions: sessions };
    });
  },

  openPalette() {
    set({ paletteOpen: true });
  },
  closePalette() {
    set({ paletteOpen: false });
  },
}));

const initialTranscriptState = new Map(
  useStore
    .getState()
    .agentSessions.map((thread) => [
      thread.id,
      { items: thread.items, updatedAt: thread.updatedAt },
    ]),
);
void loadAgentTranscripts()
  .then(({ success, records }) => {
    transcriptPersistenceEnabled = success;
    if (!success) return;
    const byId = new Map(records.map((record) => [record.id, record]));
    useStore.setState((state) => {
      let changed = false;
      const agentSessions = state.agentSessions.map((thread) => {
        const initial = initialTranscriptState.get(thread.id);
        const record = byId.get(thread.id);
        if (!initial || !record) {
          return thread;
        }
        if (thread.items !== initial.items) {
          const items = mergeAgentTranscriptItems(record.items, thread.items);
          changed = true;
          return { ...thread, items };
        }
        if (
          initial.items.length > 0 &&
          initial.updatedAt >= record.updatedAt
        ) return thread;
        changed = true;
        return { ...thread, items: record.items };
      });
      return changed ? { agentSessions } : state;
    });
  })
  .catch(() => undefined)
  .finally(() => {
    const state = useStore.getState();
    void persistAgentState(state.agentSessions, state.activeAgentId);
  });

async function persistAgentState(
  sessions: AgentThread[],
  activeAgentId: string | null,
): Promise<void> {
  if (!transcriptPersistenceEnabled) {
    if (!legacyTranscriptPending) persistAgent(sessions, activeAgentId);
    return;
  }
  const transcriptSaved = await persistAgentTranscripts(sessions);
  if (transcriptSaved) legacyTranscriptPending = false;
  if (transcriptSaved || !legacyTranscriptPending) {
    persistAgent(sessions, activeAgentId);
  }
}

// Debounce metadata and transcript writes so token-by-token streaming does not
// thrash either storage backend; reference equality skips unrelated updates.
let lastSessions = useStore.getState().agentSessions;
let lastActive = useStore.getState().activeAgentId;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state) => {
  if (
    state.agentSessions !== lastSessions ||
    state.activeAgentId !== lastActive
  ) {
    lastSessions = state.agentSessions;
    lastActive = state.activeAgentId;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void persistAgentState(lastSessions, lastActive);
    }, 500);
  }
});
