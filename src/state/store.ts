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
  Settings,
  ThemeMode,
} from "../shared/types";
import { basename, languageFromPath } from "../lib/language";
import { notifyResult } from "../lib/toast";

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

export type SidebarView = "explorer" | "search" | "git" | "extensions" | "agent";
export type PanelTab = "problems" | "output" | "debug" | "terminal" | "ports";

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
  lspLogs: LspLog[];

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
  loadAgentModels(): Promise<void>;
  loadAgentCommands(): Promise<void>;

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

  agentSessions: persistedAgent.agentSessions,
  activeAgentId: persistedAgent.activeAgentId,
  agentModels: [],
  agentCommands: [],

  paletteOpen: false,

  async bootstrap() {
    const [settings, root, recent, servers] = await Promise.all([
      window.logos.settings.getAll(),
      window.logos.workspace.getRoot(),
      window.logos.workspace.recent(),
      window.logos.lsp.list().catch(() => []),
    ]);
    const lsp: Record<string, LspProgress> = {};
    for (const s of servers)
      lsp[s.id] = { id: s.id, status: s.status, message: s.message };
    set({ settings, root, recent, lsp, ready: true });

    window.logos.settings.onChanged((s) => set({ settings: s }));
    window.logos.workspace.onChanged((r) => {
      set({ root: r });
      void get().refreshGit();
    });
    window.logos.agent.onEvent((e) => get().applyAgentEvent(e));
    // C1: the single store-side LSP status subscriber (status bar + Extensions
    // view both read this slice). lsp-monaco keeps its own subscriber for the
    // Monaco-side self-heal.
    window.logos.lsp.onProgress((p) => get().setLspProgress(p));
    window.logos.lsp.onLog((entry) => get().appendLspLog(entry));

    // Always have at least one agent session ready (the Cursor layout shows it).
    if (get().agentSessions.length === 0) get().newAgentSession("Agent 1");
    if (root) void get().refreshGit();
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
    set((s) => ({ lspLogs: [...s.lspLogs, entry].slice(-1000) }));
  },
  clearLspLogs() {
    set({ lspLogs: [] });
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
