import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type {
  AgentEvent,
  AgentQuestion,
  GitStatus,
  LanguageCode,
  LayoutMode,
  Settings,
  ThemeMode,
} from "../shared/types";
import { basename, languageFromPath } from "../lib/language";

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
  diagnostics: Record<string, Diagnostic[]>;

  agentSessions: AgentSession[];
  activeAgentId: string | null;

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
  setDiagnostics(path: string, diags: Diagnostic[]): void;

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
  diagnostics: {},

  agentSessions: [],
  activeAgentId: null,

  paletteOpen: false,

  async bootstrap() {
    const [settings, root, recent] = await Promise.all([
      window.logos.settings.getAll(),
      window.logos.workspace.getRoot(),
      window.logos.workspace.recent(),
    ]);
    set({ settings, root, recent, ready: true });

    window.logos.settings.onChanged((s) => set({ settings: s }));
    window.logos.workspace.onChanged((r) => {
      set({ root: r });
      void get().refreshGit();
    });
    window.logos.agent.onEvent((e) => get().applyAgentEvent(e));

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
      set({ git: null });
      return;
    }
    try {
      const git = await window.logos.git.status(root);
      set({ git });
    } catch {
      set({ git: null });
    }
  },
  setDiagnostics(path, diags) {
    set((s) => ({ diagnostics: { ...s.diagnostics, [path]: diags } }));
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
    set((s) => ({
      agentSessions: s.agentSessions.map((a) =>
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
    await window.logos.agent.start({
      sessionId: id!,
      prompt: text,
      cwd: root,
      model: state.settings["agent.model"] || undefined,
      permissionMode: state.settings["agent.permissionMode"],
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
            return { ...a, items, status: "idle" };
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
