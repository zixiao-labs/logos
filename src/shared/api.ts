import type {
  AgentAskResponse,
  AgentAuthContext,
  AgentEvent,
  AgentModelInfo,
  AgentPermissionResponse,
  AgentSlashCommand,
  AgentStartRequest,
  AppVersions,
  DirListing,
  FileStat,
  FsWatchEvent,
  GitBranch,
  GitLogEntry,
  GitStatus,
  LanguageServerInfo,
  LspProgress,
  Settings,
  TerminalCreateOptions,
  TerminalCreated,
  WindowControl,
} from "./types";

/** Unsubscribe handle returned by every `on…` subscription. */
export type Unsubscribe = () => void;

/**
 * The complete surface exposed on `window.logos` by the preload script.
 * The renderer talks to the main process exclusively through this object.
 */
export interface LogosAPI {
  fs: {
    readDir(path: string): Promise<DirListing>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    stat(path: string): Promise<FileStat>;
    createFile(path: string, content?: string): Promise<void>;
    createDir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    delete(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    watch(path: string): Promise<void>;
    unwatch(path: string): Promise<void>;
    onWatchEvent(cb: (e: FsWatchEvent) => void): Unsubscribe;
  };
  dialog: {
    openFolder(): Promise<string | null>;
    openFile(): Promise<string | null>;
    saveFile(defaultPath?: string): Promise<string | null>;
  };
  workspace: {
    getRoot(): Promise<string | null>;
    setRoot(path: string): Promise<void>;
    recent(): Promise<string[]>;
    onChanged(cb: (root: string | null) => void): Unsubscribe;
  };
  git: {
    status(root: string): Promise<GitStatus>;
    stage(root: string, paths: string[]): Promise<void>;
    unstage(root: string, paths: string[]): Promise<void>;
    discard(root: string, paths: string[]): Promise<void>;
    commit(root: string, message: string): Promise<void>;
    branches(root: string): Promise<GitBranch[]>;
    checkout(root: string, branch: string): Promise<void>;
    createBranch(root: string, name: string): Promise<void>;
    diff(root: string, path: string, staged: boolean): Promise<string>;
    log(root: string, limit?: number): Promise<GitLogEntry[]>;
    init(root: string): Promise<void>;
    pull(root: string): Promise<string>;
    push(root: string): Promise<string>;
  };
  terminal: {
    create(opts: TerminalCreateOptions): Promise<TerminalCreated>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    onData(id: string, cb: (data: string) => void): Unsubscribe;
    onExit(id: string, cb: (code: number) => void): Unsubscribe;
  };
  settings: {
    getAll(): Promise<Settings>;
    set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings>;
    setMany(patch: Partial<Settings>): Promise<Settings>;
    reset(): Promise<Settings>;
    getPath(): Promise<string>;
    onChanged(cb: (settings: Settings) => void): Unsubscribe;
  };
  agent: {
    start(req: AgentStartRequest): Promise<void>;
    interrupt(sessionId: string): Promise<void>;
    respondPermission(res: AgentPermissionResponse): Promise<void>;
    respondAsk(res: AgentAskResponse): Promise<void>;
    /** List models the SDK reports (empty array if unavailable, e.g. no auth). */
    listModels(ctx?: AgentAuthContext): Promise<AgentModelInfo[]>;
    /** List slash-commands discovered from .claude (empty if unavailable). */
    listCommands(ctx?: AgentAuthContext): Promise<AgentSlashCommand[]>;
    onEvent(cb: (e: AgentEvent) => void): Unsubscribe;
  };
  lsp: {
    list(): Promise<LanguageServerInfo[]>;
    install(id: string): Promise<void>;
    uninstall(id: string): Promise<void>;
    start(serverId: string, root: string): Promise<void>;
    stop(serverId: string): Promise<void>;
    /** Generic JSON-RPC passthrough to a running server. */
    request(serverId: string, method: string, params: unknown): Promise<unknown>;
    onProgress(cb: (p: LspProgress) => void): Unsubscribe;
    onNotify(
      cb: (n: { serverId: string; method: string; params: unknown }) => void,
    ): Unsubscribe;
  };
  app: {
    versions(): Promise<AppVersions>;
    platform(): Promise<NodeJS.Platform>;
    windowControl(action: WindowControl): void;
    onWindowState(cb: (s: { maximized: boolean }) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    logos: LogosAPI;
  }
}
