import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type {
  AgentAuthContext,
  AgentEvent,
  AgentModelInfo,
  AgentQuestion,
  AgentSlashCommand,
  AgentThinkingConfig,
  GitStatus,
  GitLogEntry,
  LanguageCode,
  LayoutMode,
  LspLog,
  LspProgress,
  LspWorkDoneProgress,
  Settings,
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
  url?: string;
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

export interface TerminalInstance {
  id: string;
  name: string;
  pid: number;
}

export type AgentItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; thinking: string }
  | {
      id: string;
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      isError?: boolean;
      result?: string;
    }
  | { id: string; kind: "result"; costUsd: number | null; durationMs: number }
  | { id: string; kind: "error"; message: string };

export interface AgentSession {
  id: string;
  name: string;
  items: AgentItem[];
  status: "idle" | "running";
  /** SDK session id captured from the result event; used to resume (F2). */
  sdkSessionId?: string;
  pendingAsk?: { requestId: string; questions: AgentQuestion[] };
  pendingPermission?: { requestId: string; toolName: string; input: unknown };
}

export interface Diagnostic {
  message: string;
  severity: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  source?: string;
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
  diagnostics: Record<string, Diagnostic[]>;
  /** Language-server status keyed by server id (C1: surfaced in the status bar). */
  lsp: Record<string, LspProgress>;
  /** Language-server stderr/installer/client logs shown in the Output panel. */
  lspLogs: StoredLspLog[];
  lspWorkDone: Record<string, LspWorkDoneProgress>;

  debug: DebugViewState;

  agentSessions: AgentSession[];
  activeAgentId: string | null;
  /** Cached model list from the SDK (D1). Empty until loaded / if unavailable. */
  agentModels: AgentModelInfo[];
  /** Cached slash-commands from the SDK (D4). */
  agentCommands: AgentSlashCommand[];

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

  newTerminal(): Promise<void>;
  closeTerminal(id: string): void;
  setActiveTerminal(id: string): void;

  refreshGit(): Promise<void>;
  /** Git remote actions shared by the SCM panel and the native menu. */
  gitFetch(): Promise<void>;
  gitPull(): Promise<void>;
  gitPush(): Promise<void>;
  gitSync(): Promise<void>;
  setDiagnostics(path: string, diags: Diagnostic[]): void;
  setLspProgress(p: LspProgress): void;
  appendLspLog(entry: LspLog): void;
  clearLspLogs(): void;
  setLspWorkDone(progress: LspWorkDoneProgress): void;
  clearLspWorkDone(serverId: string, token: string | number): void;
  loadAgentModels(): Promise<void>;
  loadAgentCommands(): Promise<void>;

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

  newAgentSession(name?: string): string;
  removeAgentSession(id: string): void;
  setActiveAgent(id: string): void;
  sendAgentPrompt(text: string): Promise<void>;
  interruptAgent(): Promise<void>;
  answerAsk(
    requestId: string,
    answers: Record<string, string | string[]>,
    response?: string,
  ): Promise<void>;
  respondPermission(
    requestId: string,
    behavior: "allow" | "deny",
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
// A focused localStorage persister: only agent conversations + the SDK session
// id survive a restart, so `resume` can rejoin the CLI session. Transient state
// (running status, pending permission/ask) is never restored — the main-process
// side of those is gone after a restart.
const AGENT_PERSIST_KEY = "logos.agent.v1";

function loadPersistedAgent(): {
  agentSessions: AgentSession[];
  activeAgentId: string | null;
} {
  try {
    const raw = localStorage.getItem(AGENT_PERSIST_KEY);
    if (!raw) return { agentSessions: [], activeAgentId: null };
    const parsed = JSON.parse(raw) as {
      agentSessions?: AgentSession[];
      activeAgentId?: string | null;
    };
    const agentSessions = (parsed.agentSessions ?? []).map(
      (a): AgentSession => ({
        id: a.id,
        name: a.name,
        items: a.items ?? [],
        sdkSessionId: a.sdkSessionId,
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
  agentSessions: AgentSession[],
  activeAgentId: string | null,
): void {
  try {
    localStorage.setItem(
      AGENT_PERSIST_KEY,
      JSON.stringify({
        agentSessions: agentSessions.map((a) => ({
          id: a.id,
          name: a.name,
          items: a.items,
          sdkSessionId: a.sdkSessionId,
        })),
        activeAgentId,
      }),
    );
  } catch {
    /* storage unavailable / quota exceeded — non-fatal */
  }
}

const persistedAgent = loadPersistedAgent();

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
          breakpoints.map((breakpoint) => ({
            ...breakpoint,
            verified: false,
            message: undefined,
          })),
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
    localStorage.setItem(DEBUG_BREAKPOINTS_KEY, JSON.stringify(breakpoints));
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
  };
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

function dapBreakpoints(
  breakpoints: Record<string, DebugBreakpointState[]>,
): Record<string, DapSourceBreakpoint[]> {
  return Object.fromEntries(
    Object.entries(breakpoints).map(([sourcePath, sourceBreakpoints]) => [
      sourcePath,
      sourceBreakpoints.map(({ line, column, condition, hitCondition, logMessage }) => ({
        line,
        ...(column == null ? {} : { column }),
        ...(condition ? { condition } : {}),
        ...(hitCondition ? { hitCondition } : {}),
        ...(logMessage ? { logMessage } : {}),
      })),
    ]),
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
  diagnostics: {},
  lsp: {},
  lspLogs: [],
  lspWorkDone: {},

  debug: initialDebugState(),

  agentSessions: persistedAgent.agentSessions,
  activeAgentId: persistedAgent.activeAgentId,
  agentModels: [],
  agentCommands: [],

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
    if (root) void get().refreshGit();
    void get().loadDebugConfigurations();
  },

  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    await window.logos.settings.set(key, value);
  },
  async setManySettings(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    await window.logos.settings.setMany(patch);
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

  async newTerminal() {
    const created = await window.logos.terminal.create({
      cwd: get().root ?? undefined,
    });
    const inst: TerminalInstance = {
      id: created.id,
      name: `${basename(created.shell)} ${get().terminals.length + 1}`,
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

  async loadDebugConfigurations() {
    const root = get().root;
    if (!root) {
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
      set((state) => ({
        debug: {
          ...state.debug,
          configurations: file.configurations,
          configurationPath,
          configurationError: null,
        },
      }));
    } catch (error) {
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
        initialBreakpoints: dapBreakpoints(get().debug.breakpoints),
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
    if (sessionId) await window.logos.debug.stop(sessionId, true);
  },
  async debugContinue() {
    const debug = get().debug;
    if (!debug.activeSessionId || debug.selectedThreadId == null) return;
    await window.logos.debug.request(debug.activeSessionId, "continue", {
      threadId: debug.selectedThreadId,
    });
  },
  async debugPause() {
    const debug = get().debug;
    if (!debug.activeSessionId) return;
    let threadId = debug.selectedThreadId ?? debug.threads[0]?.id;
    if (threadId == null) {
      const response = await window.logos.debug.request<{ threads?: DapThread[] }>(
        debug.activeSessionId,
        "threads",
      );
      const threads = response.body?.threads ?? [];
      threadId = threads[0]?.id;
      set((state) => ({
        debug: { ...state.debug, threads },
      }));
    }
    if (threadId == null) return;
    await window.logos.debug.request(debug.activeSessionId, "pause", {
      threadId,
    });
  },
  async debugStep(command) {
    const debug = get().debug;
    if (!debug.activeSessionId || debug.selectedThreadId == null) return;
    await window.logos.debug.request(debug.activeSessionId, command, {
      threadId: debug.selectedThreadId,
      granularity: "statement",
    });
  },
  async toggleBreakpoint(sourcePath, line) {
    const current = get().debug.breakpoints[sourcePath] ?? [];
    const existing = current.find((breakpoint) => breakpoint.line === line);
    const next = existing
      ? current.filter((breakpoint) => breakpoint.id !== existing.id)
      : [
          ...current,
          {
            id: crypto.randomUUID(),
            line,
            verified: false,
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
    try {
      const protocolBreakpoints = await window.logos.debug.setBreakpoints(
        debug.activeSessionId,
        sourcePath,
        next,
      );
      set((state) => ({
        debug: {
          ...state.debug,
          breakpoints: {
            ...state.debug.breakpoints,
            [sourcePath]: next.map((breakpoint, index) => ({
              ...breakpoint,
              verified: protocolBreakpoints[index]?.verified,
              message: protocolBreakpoints[index]?.message,
              line: protocolBreakpoints[index]?.line ?? breakpoint.line,
            })),
          },
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
          ],
        },
      }));
    }
  },
  async selectDebugThread(threadId) {
    const sessionId = get().debug.activeSessionId;
    if (!sessionId) return;
    set((state) => ({
      debug: { ...state.debug, selectedThreadId: threadId },
    }));
    try {
      const response = await window.logos.debug.request<{
        stackFrames?: DapStackFrame[];
      }>(sessionId, "stackTrace", { threadId, startFrame: 0, levels: 100 });
      const stackFrames = response.body?.stackFrames ?? [];
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
      set((state) => ({
        debug: {
          ...state.debug,
          console: [
            ...state.debug.console,
            consoleEntry(
              "error",
              `${error instanceof Error ? error.message : String(error)}\n`,
            ),
          ],
        },
      }));
    }
  },
  async selectDebugFrame(frameId) {
    const debug = get().debug;
    const sessionId = debug.activeSessionId;
    if (!sessionId) return;
    const frame = debug.stackFrames.find((item) => item.id === frameId);
    set((state) => ({
      debug: {
        ...state.debug,
        selectedFrameId: frameId,
        scopes: [],
        variables: {},
      },
    }));
    if (frame?.source?.path) get().openFile(frame.source.path);
    try {
      const response = await window.logos.debug.request<{ scopes?: DapScope[] }>(
        sessionId,
        "scopes",
        { frameId },
      );
      const scopes = response.body?.scopes ?? [];
      set((state) => ({
        debug: { ...state.debug, scopes },
      }));
      await Promise.all(
        scopes.map((scope) => get().loadDebugVariables(scope.variablesReference)),
      );
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
          ],
        },
      }));
    }
  },
  async loadDebugVariables(reference) {
    if (!reference) return;
    const sessionId = get().debug.activeSessionId;
    if (!sessionId) return;
    const response = await window.logos.debug.request<{
      variables?: DapVariable[];
    }>(sessionId, "variables", { variablesReference: reference });
    set((state) => ({
      debug: {
        ...state.debug,
        variables: {
          ...state.debug.variables,
          [reference]: response.body?.variables ?? [],
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
        ],
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
          ],
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
          ],
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
              ]
            : state.debug.console;
        const sessions = {
          ...state.debug.sessions,
          [event.session.id]: event.session,
        };
        const allSessionsEnded = Object.values(sessions).every(
          (session) =>
            session.status === "terminated" || session.status === "error",
        );
        const breakpoints = allSessionsEnded
          ? Object.fromEntries(
              Object.entries(state.debug.breakpoints).map(
                ([sourcePath, sourceBreakpoints]) => [
                  sourcePath,
                  sourceBreakpoints.map((breakpoint) => ({
                    ...breakpoint,
                    verified: false,
                    message: undefined,
                  })),
                ],
              ),
            )
          : state.debug.breakpoints;
        const fallbackSession = Object.values(sessions).find(
          (session) =>
            session.status !== "terminated" && session.status !== "error",
        );
        const activeSessionId = ended
          ? state.debug.activeSessionId === event.session.id
            ? (fallbackSession?.id ?? event.session.id)
            : state.debug.activeSessionId
          : event.session.id;
        return {
          debug: {
            ...state.debug,
            sessions,
            activeSessionId,
            breakpoints,
            console,
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
    if (event.kind === "breakpoints") {
      set((state) => ({
        debug: {
          ...state.debug,
          breakpoints: {
            ...state.debug.breakpoints,
            [event.sourcePath]: (
              state.debug.breakpoints[event.sourcePath] ?? []
            ).map((breakpoint, index) => ({
              ...breakpoint,
              verified: event.breakpoints[index]?.verified,
              message: event.breakpoints[index]?.message,
              line: event.breakpoints[index]?.line ?? breakpoint.line,
            })),
          },
        },
      }));
      return;
    }

    const dapEvent = event.event;
    if (dapEvent.event === "output") {
      const body = dapEvent.body as DapOutputEventBody | undefined;
      if (body?.output) {
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
      set((state) => ({
        panelVisible: true,
        panelTab: "debug",
        debug: {
          ...state.debug,
          activeSessionId: event.sessionId,
          stoppedReason: body?.description ?? body?.reason ?? "stopped",
        },
      }));
      void window.logos.debug
        .request<{ threads?: DapThread[] }>(event.sessionId, "threads")
        .then(async (response) => {
          const threads = response.body?.threads ?? [];
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
          set((state) => ({
            debug: {
              ...state.debug,
              console: [
                ...state.debug.console,
                consoleEntry(
                  "error",
                  `${error instanceof Error ? error.message : String(error)}\n`,
                ),
              ],
            },
          }));
        });
    } else if (dapEvent.event === "continued") {
      set((state) => ({
        debug: {
          ...state.debug,
          stackFrames: [],
          selectedFrameId: null,
          scopes: [],
          variables: {},
          stoppedReason: null,
        },
      }));
    } else if (dapEvent.event === "thread") {
      const session = get().debug.sessions[event.sessionId];
      if (session?.status === "stopped") {
        void window.logos.debug
          .request<{ threads?: DapThread[] }>(event.sessionId, "threads")
          .then((response) =>
            set((state) => ({
              debug: {
                ...state.debug,
                threads: response.body?.threads ?? [],
              },
            })),
          );
      }
    } else if (dapEvent.event === "breakpoint") {
      const body = dapEvent.body as
        | { reason?: string; breakpoint?: DapBreakpoint }
        | undefined;
      const protocolBreakpoint = body?.breakpoint;
      if (protocolBreakpoint?.source?.path && protocolBreakpoint.line != null) {
        const sourcePath = protocolBreakpoint.source.path;
        set((state) => ({
          debug: {
            ...state.debug,
            breakpoints: {
              ...state.debug.breakpoints,
              [sourcePath]: (state.debug.breakpoints[sourcePath] ?? []).map(
                (breakpoint) =>
                  breakpoint.line === protocolBreakpoint.line
                    ? {
                        ...breakpoint,
                        verified: protocolBreakpoint.verified,
                        message: protocolBreakpoint.message,
                      }
                    : breakpoint,
              ),
            },
          },
        }));
      }
    }
  },

  newAgentSession(name) {
    const id = crypto.randomUUID();
    const session: AgentSession = {
      id,
      name: name ?? `Agent ${get().agentSessions.length + 1}`,
      items: [],
      status: "idle",
    };
    set((s) => ({
      agentSessions: [...s.agentSessions, session],
      activeAgentId: id,
    }));
    return id;
  },
  removeAgentSession(id) {
    void window.logos.agent.interrupt(id);
    set((s) => {
      const agentSessions = s.agentSessions.filter((a) => a.id !== id);
      const activeAgentId =
        s.activeAgentId === id
          ? (agentSessions[agentSessions.length - 1]?.id ?? null)
          : s.activeAgentId;
      return { agentSessions, activeAgentId };
    });
  },
  setActiveAgent(id) {
    set({ activeAgentId: id });
  },
  async sendAgentPrompt(text) {
    const state = get();
    let id = state.activeAgentId;
    if (!id) id = get().newAgentSession();
    const root = state.root ?? ".";
    const s = state.settings;
    // sdkSessionId survives restarts (F2): resume the CLI session if present.
    const session = state.agentSessions.find((a) => a.id === id);
    set((st) => ({
      agentSessions: st.agentSessions.map((a) =>
        a.id === id
          ? {
              ...a,
              status: "running",
              pendingAsk: undefined,
              pendingPermission: undefined,
              items: [
                ...a.items,
                { id: crypto.randomUUID(), kind: "user", text },
              ],
            }
          : a,
      ),
    }));
    const allowed = s["agent.allowedTools"];
    const disallowed = s["agent.disallowedTools"];
    await window.logos.agent.start({
      sessionId: id!,
      prompt: text,
      cwd: root,
      // `|| undefined` everywhere => "empty means no override", mirroring model.
      model: s["agent.model"] || undefined,
      permissionMode: s["agent.permissionMode"],
      resume: session?.sdkSessionId,
      effort: s["agent.effort"] || undefined,
      thinking: thinkingConfig(s["agent.thinking"], s["agent.thinkingBudget"]),
      allowedTools: allowed.length ? allowed : undefined,
      disallowedTools: disallowed.length ? disallowed : undefined,
      settingSources: s["agent.loadProjectSettings"]
        ? ["user", "project"]
        : undefined,
      apiKey: s["agent.apiKey"] || undefined,
      authToken: s["agent.authToken"] || undefined,
      baseUrl: s["agent.baseUrl"] || undefined,
    });
  },
  async interruptAgent() {
    const id = get().activeAgentId;
    if (id) await window.logos.agent.interrupt(id);
  },
  async answerAsk(requestId, answers, response) {
    await window.logos.agent.respondAsk({ requestId, answers, response });
    set((s) => ({
      agentSessions: s.agentSessions.map((a) =>
        a.pendingAsk?.requestId === requestId
          ? { ...a, pendingAsk: undefined }
          : a,
      ),
    }));
  },
  async respondPermission(requestId, behavior) {
    await window.logos.agent.respondPermission({ requestId, behavior });
    set((s) => ({
      agentSessions: s.agentSessions.map((a) =>
        a.pendingPermission?.requestId === requestId
          ? { ...a, pendingPermission: undefined }
          : a,
      ),
    }));
  },
  applyAgentEvent(e) {
    set((s) => {
      const sessions = s.agentSessions.map((a): AgentSession => {
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
          case "text-delta": {
            let idx = findAssistant(e.messageId);
            if (idx === -1) {
              items.push({
                id: e.messageId,
                kind: "assistant",
                text: "",
                thinking: "",
              });
              idx = items.length - 1;
            }
            const it = items[idx] as Extract<AgentItem, { kind: "assistant" }>;
            items[idx] = { ...it, text: it.text + e.delta };
            return { ...a, items };
          }
          case "text": {
            const idx = findAssistant(e.messageId);
            if (idx === -1) {
              items.push({
                id: e.messageId,
                kind: "assistant",
                text: e.text,
                thinking: "",
              });
            } else {
              const it = items[idx] as Extract<
                AgentItem,
                { kind: "assistant" }
              >;
              items[idx] = { ...it, text: e.text };
            }
            return { ...a, items };
          }
          case "thinking": {
            let idx = findAssistant(e.messageId);
            if (idx === -1) {
              items.push({
                id: e.messageId,
                kind: "assistant",
                text: "",
                thinking: "",
              });
              idx = items.length - 1;
            }
            const it = items[idx] as Extract<AgentItem, { kind: "assistant" }>;
            items[idx] = { ...it, thinking: it.thinking + e.delta };
            return { ...a, items };
          }
          case "tool-use":
            items.push({
              id: e.toolUseId,
              kind: "tool",
              toolUseId: e.toolUseId,
              name: e.name,
              input: e.input,
            });
            return { ...a, items };
          case "tool-result": {
            const idx = items.findIndex(
              (it) => it.kind === "tool" && it.toolUseId === e.toolUseId,
            );
            if (idx !== -1) {
              const it = items[idx] as Extract<AgentItem, { kind: "tool" }>;
              items[idx] = { ...it, isError: e.isError, result: e.content };
            }
            return { ...a, items };
          }
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
            };
          case "error":
            items.push({
              id: crypto.randomUUID(),
              kind: "error",
              message: e.message,
            });
            return { ...a, items, status: "idle" };
          case "permission":
            return {
              ...a,
              pendingPermission: {
                requestId: e.requestId,
                toolName: e.toolName,
                input: e.input,
              },
            };
          case "ask":
            return {
              ...a,
              pendingAsk: { requestId: e.requestId, questions: e.questions },
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

// F2: write agent conversations to localStorage when they change. Debounced so
// token-by-token streaming (which rebuilds agentSessions on every delta) does
// not thrash storage; reference equality skips unrelated state updates.
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
    persistTimer = setTimeout(
      () => persistAgent(lastSessions, lastActive),
      500,
    );
  }
});
