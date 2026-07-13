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
  LspClientRequest,
  LspLog,
  LspProgress,
  MenuAction,
  Settings,
  TerminalCreateOptions,
  TerminalCreated,
  WindowControl,
} from "./types";
import type { ServerCapabilities } from "vscode-languageserver-protocol";

/** Unsubscribe handle returned by every `on…` subscription. */
export type Unsubscribe = () => void;

export type LspResourceOperation =
  | { kind: "create"; path: string; overwrite?: boolean }
  | { kind: "rename"; from: string; to: string; overwrite?: boolean }
  | { kind: "delete"; path: string };

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
    /** Amend HEAD; an empty message reuses the previous commit message. */
    commitAmend(root: string, message: string): Promise<void>;
    /** The current HEAD commit, or null for an empty / non-repo. */
    head(root: string): Promise<GitLogEntry | null>;
    /** Soft-reset HEAD~1: undo the last commit, keeping changes staged. */
    undoLastCommit(root: string): Promise<void>;
    branches(root: string): Promise<GitBranch[]>;
    checkout(root: string, branch: string): Promise<void>;
    createBranch(root: string, name: string): Promise<void>;
    diff(root: string, path: string, staged: boolean): Promise<string>;
    log(root: string, limit?: number): Promise<GitLogEntry[]>;
    init(root: string): Promise<void>;
    fetch(root: string): Promise<string>;
    pull(root: string): Promise<string>;
    push(root: string): Promise<string>;
    /** Pull (rebase) then push. */
    sync(root: string): Promise<string>;
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
    start(serverId: string, root: string): Promise<ServerCapabilities>;
    stop(serverId: string): Promise<void>;
    /** Generic JSON-RPC passthrough to a running server. */
    request(
      serverId: string,
      method: string,
      params: unknown,
      requestId?: number,
    ): Promise<unknown>;
    notify(serverId: string, method: string, params: unknown): void;
    cancelRequest(serverId: string, requestId: number): void;
    resourceOperation(operation: LspResourceOperation): Promise<void>;
    directoryIsEmpty(path: string): Promise<boolean>;
    onProgress(cb: (p: LspProgress) => void): Unsubscribe;
    onLog(cb: (entry: LspLog) => void): Unsubscribe;
    onNotify(
      cb: (n: { serverId: string; method: string; params: unknown }) => void,
    ): Unsubscribe;
    onRequest(
      cb: (request: LspClientRequest) => Promise<unknown>,
    ): Unsubscribe;
  };
  app: {
    versions(): Promise<AppVersions>;
    platform(): Promise<NodeJS.Platform>;
    openExternal(url: string): Promise<void>;
    windowControl(action: WindowControl): void;
    onWindowState(cb: (s: { maximized: boolean }) => void): Unsubscribe;
    /** Native-menu actions dispatched from the main process. */
    onMenuAction(cb: (action: MenuAction) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    logos: LogosAPI;
  }
}
