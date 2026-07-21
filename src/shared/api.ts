import type {
  AgentAskResponse,
  AgentAuthRequest,
  AgentAuthResult,
  AgentAuthContext,
  AgentCredentialStatus,
  AgentEvent,
  AgentModelInfo,
  AgentPermissionResponse,
  AgentProviderConfig,
  AgentProviderInfo,
  AgentSetConfigRequest,
  AgentSlashCommand,
  AgentStartRequest,
  AcpAgentConfig,
  AcpRegistryAgent,
  AppVersions,
  DirListing,
  FileStat,
  FileSnapshot,
  ConditionalWriteResult,
  FsWatchEvent,
  GitBranch,
  GitBlameLine,
  GitFileDiff,
  GitGraphEntry,
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
  WorkspaceSnapshot,
} from "./types";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import type {
  DapArguments,
  DapBreakpoint,
  DapResponse,
  DapSourceBreakpoint,
  DebugAdapterInfo,
  DebugSessionEvent,
  DebugSessionInfo,
  DebugStartRequest,
} from "./dap";
import type { ExtensionRegistrySnapshot } from "./extensions";

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
    readFileSnapshot(path: string): Promise<FileSnapshot>;
    writeFile(path: string, content: string): Promise<void>;
    /**
     * Detects conflicts before an atomic replacement. Portable filesystems do
     * not provide compare-and-swap for an existing path, so success is
     * explicitly optimistic with respect to external writers.
     */
    writeFileConditional(
      path: string,
      content: string,
      expectedRevision: string,
    ): Promise<ConditionalWriteResult>;
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
    getFolders(): Promise<string[]>;
    setRoot(path: string): Promise<void>;
    addFolder(): Promise<WorkspaceSnapshot | null>;
    removeFolder(path: string): Promise<WorkspaceSnapshot>;
    recent(): Promise<string[]>;
    onChanged(cb: (workspace: WorkspaceSnapshot) => void): Unsubscribe;
  };
  extensions: {
    list(): Promise<ExtensionRegistrySnapshot>;
    install(id: string): Promise<ExtensionRegistrySnapshot>;
    uninstall(id: string): Promise<ExtensionRegistrySnapshot>;
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
    fileDiff(root: string, path: string, staged: boolean): Promise<GitFileDiff>;
    log(root: string, limit?: number): Promise<GitLogEntry[]>;
    graph(root: string, limit?: number): Promise<GitGraphEntry[]>;
    /** Blame one 1-based line in an absolute working-tree file path. */
    blame(root: string, path: string, line: number): Promise<GitBlameLine | null>;
    init(root: string): Promise<void>;
    fetch(root: string): Promise<string>;
    pull(root: string): Promise<string>;
    push(root: string): Promise<string>;
    /** Pull (rebase) then push. */
    sync(root: string): Promise<string>;
    watch(roots: string[]): Promise<void>;
    onChanged(cb: (root: string) => void): Unsubscribe;
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
    setAcpSecret(
      serverId: string,
      name: string,
      value: string,
      reference?: string,
    ): Promise<string>;
    deleteAcpSecret(reference: string): Promise<void>;
    onChanged(cb: (settings: Settings) => void): Unsubscribe;
  };
  agent: {
    start(req: AgentStartRequest): Promise<void>;
    interrupt(sessionId: string): Promise<void>;
    close(sessionId: string): Promise<void>;
    respondPermission(res: AgentPermissionResponse): Promise<void>;
    respondAsk(res: AgentAskResponse): Promise<void>;
    /** List models the SDK reports (empty array if unavailable, e.g. no auth). */
    listModels(ctx?: AgentAuthContext): Promise<AgentModelInfo[]>;
    /** List slash-commands discovered from .claude (empty if unavailable). */
    listCommands(ctx?: AgentAuthContext): Promise<AgentSlashCommand[]>;
    setMode(sessionId: string, modeId: string): Promise<void>;
    setModel(sessionId: string, modelId: string): Promise<void>;
    setConfig(request: AgentSetConfigRequest): Promise<void>;
    authenticate(request: AgentAuthRequest): Promise<AgentAuthResult>;
    listProviders(sessionId: string): Promise<AgentProviderInfo[]>;
    setProvider(sessionId: string, config: AgentProviderConfig): Promise<void>;
    disableProvider(sessionId: string, providerId: string): Promise<void>;
    authStatus(): Promise<AgentCredentialStatus>;
    loginChatGPT(): Promise<AgentCredentialStatus>;
    setOpenAIKey(apiKey: string): Promise<AgentCredentialStatus>;
    logoutOpenAI(): Promise<void>;
    listRegistry(forceRefresh?: boolean): Promise<AcpRegistryAgent[]>;
    resolveRegistryAgent(id: string): Promise<AcpAgentConfig>;
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
  debug: {
    list(): Promise<DebugSessionInfo[]>;
    listAdapters(): Promise<DebugAdapterInfo[]>;
    start(request: DebugStartRequest): Promise<DebugSessionInfo>;
    stop(sessionId: string, terminateDebuggee?: boolean): Promise<void>;
    request<T = unknown>(
      sessionId: string,
      command: string,
      args?: DapArguments,
    ): Promise<DapResponse<T>>;
    setBreakpoints(
      sessionId: string,
      sourcePath: string,
      breakpoints: DapSourceBreakpoint[],
    ): Promise<DapBreakpoint[]>;
    onEvent(cb: (event: DebugSessionEvent) => void): Unsubscribe;
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
