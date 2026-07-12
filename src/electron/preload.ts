import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH } from "../shared/channels";
import type { LogosAPI, Unsubscribe } from "../shared/api";
import type {
  AgentAskResponse,
  AgentEvent,
  AgentPermissionResponse,
  AgentStartRequest,
  FsWatchEvent,
  LspLog,
  LspProgress,
  MenuAction,
  Settings,
  TerminalCreateOptions,
  WindowControl,
} from "../shared/types";

/** Subscribe to a broadcast channel; returns an unsubscribe handle. */
function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: LogosAPI = {
  fs: {
    readDir: (p) => ipcRenderer.invoke(CH.fsReadDir, p),
    readFile: (p) => ipcRenderer.invoke(CH.fsReadFile, p),
    writeFile: (p, content) => ipcRenderer.invoke(CH.fsWriteFile, p, content),
    stat: (p) => ipcRenderer.invoke(CH.fsStat, p),
    createFile: (p, content) => ipcRenderer.invoke(CH.fsCreateFile, p, content),
    createDir: (p) => ipcRenderer.invoke(CH.fsCreateDir, p),
    rename: (from, to) => ipcRenderer.invoke(CH.fsRename, from, to),
    delete: (p) => ipcRenderer.invoke(CH.fsDelete, p),
    exists: (p) => ipcRenderer.invoke(CH.fsExists, p),
    watch: (p) => ipcRenderer.invoke(CH.fsWatch, p),
    unwatch: (p) => ipcRenderer.invoke(CH.fsUnwatch, p),
    onWatchEvent: (cb) => on<FsWatchEvent>(CH.fsWatchEvent, cb),
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke(CH.dialogOpenFolder),
    openFile: () => ipcRenderer.invoke(CH.dialogOpenFile),
    saveFile: (defaultPath) => ipcRenderer.invoke(CH.dialogSaveFile, defaultPath),
  },
  workspace: {
    getRoot: () => ipcRenderer.invoke(CH.workspaceGetRoot),
    setRoot: (p) => ipcRenderer.invoke(CH.workspaceSetRoot, p),
    recent: () => ipcRenderer.invoke(CH.workspaceRecent),
    onChanged: (cb) => on<string | null>(CH.workspaceChanged, cb),
  },
  git: {
    status: (root) => ipcRenderer.invoke(CH.gitStatus, root),
    stage: (root, paths) => ipcRenderer.invoke(CH.gitStage, root, paths),
    unstage: (root, paths) => ipcRenderer.invoke(CH.gitUnstage, root, paths),
    discard: (root, paths) => ipcRenderer.invoke(CH.gitDiscard, root, paths),
    commit: (root, message) => ipcRenderer.invoke(CH.gitCommit, root, message),
    commitAmend: (root, message) =>
      ipcRenderer.invoke(CH.gitCommitAmend, root, message),
    head: (root) => ipcRenderer.invoke(CH.gitHead, root),
    undoLastCommit: (root) => ipcRenderer.invoke(CH.gitUndoLastCommit, root),
    branches: (root) => ipcRenderer.invoke(CH.gitBranches, root),
    checkout: (root, branch) => ipcRenderer.invoke(CH.gitCheckout, root, branch),
    createBranch: (root, name) =>
      ipcRenderer.invoke(CH.gitCreateBranch, root, name),
    diff: (root, p, staged) => ipcRenderer.invoke(CH.gitDiff, root, p, staged),
    log: (root, limit) => ipcRenderer.invoke(CH.gitLog, root, limit),
    init: (root) => ipcRenderer.invoke(CH.gitInit, root),
    fetch: (root) => ipcRenderer.invoke(CH.gitFetch, root),
    pull: (root) => ipcRenderer.invoke(CH.gitPull, root),
    push: (root) => ipcRenderer.invoke(CH.gitPush, root),
    sync: (root) => ipcRenderer.invoke(CH.gitSync, root),
  },
  terminal: {
    create: (opts: TerminalCreateOptions) =>
      ipcRenderer.invoke(CH.terminalCreate, opts),
    write: (id, data) => ipcRenderer.send(CH.terminalWrite, id, data),
    resize: (id, cols, rows) =>
      ipcRenderer.send(CH.terminalResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(CH.terminalKill, id),
    onData: (id, cb) =>
      on<{ id: string; data: string }>(CH.terminalData, (p) => {
        if (p.id === id) cb(p.data);
      }),
    onExit: (id, cb) =>
      on<{ id: string; code: number }>(CH.terminalExit, (p) => {
        if (p.id === id) cb(p.code);
      }),
  },
  settings: {
    getAll: () => ipcRenderer.invoke(CH.settingsGetAll),
    set: (key, value) =>
      ipcRenderer.invoke(CH.settingsSet, { [key]: value } as Partial<Settings>),
    setMany: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
    reset: () => ipcRenderer.invoke(CH.settingsReset),
    getPath: () => ipcRenderer.invoke(CH.settingsGetPath),
    onChanged: (cb) => on<Settings>(CH.settingsChanged, cb),
  },
  agent: {
    start: (req: AgentStartRequest) => ipcRenderer.invoke(CH.agentStart, req),
    interrupt: (sessionId) => ipcRenderer.invoke(CH.agentInterrupt, sessionId),
    respondPermission: (res: AgentPermissionResponse) =>
      ipcRenderer.invoke(CH.agentRespondPermission, res),
    respondAsk: (res: AgentAskResponse) =>
      ipcRenderer.invoke(CH.agentRespondAsk, res),
    listModels: (ctx) => ipcRenderer.invoke(CH.agentListModels, ctx),
    listCommands: (ctx) => ipcRenderer.invoke(CH.agentListCommands, ctx),
    onEvent: (cb) => on<AgentEvent>(CH.agentEvent, cb),
  },
  lsp: {
    list: () => ipcRenderer.invoke(CH.lspList),
    install: (id) => ipcRenderer.invoke(CH.lspInstall, id),
    uninstall: (id) => ipcRenderer.invoke(CH.lspUninstall, id),
    start: (serverId, root) => ipcRenderer.invoke(CH.lspStart, serverId, root),
    stop: (serverId) => ipcRenderer.invoke(CH.lspStop, serverId),
    request: (serverId, method, params) =>
      ipcRenderer.invoke(CH.lspRequest, serverId, method, params),
    onProgress: (cb) => on<LspProgress>(CH.lspProgress, cb),
    onLog: (cb) => on<LspLog>(CH.lspLog, cb),
    onNotify: (cb) =>
      on<{ serverId: string; method: string; params: unknown }>(
        CH.lspNotify,
        cb,
      ),
    onRequest: (cb) => {
      const listener = async (
        _e: IpcRendererEvent,
        request: {
          requestId: number;
          serverId: string;
          method: string;
          params: unknown;
        },
      ) => {
        try {
          const result = await cb(request);
          await ipcRenderer.invoke(CH.lspClientResponse, request.requestId, {
            result,
          });
        } catch (error) {
          await ipcRenderer.invoke(CH.lspClientResponse, request.requestId, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      ipcRenderer.on(CH.lspClientRequest, listener);
      return () => ipcRenderer.removeListener(CH.lspClientRequest, listener);
    },
  },
  app: {
    versions: () => ipcRenderer.invoke(CH.appVersions),
    platform: () => ipcRenderer.invoke(CH.appPlatform),
    windowControl: (action: WindowControl) =>
      ipcRenderer.send(CH.windowControl, action),
    onWindowState: (cb) => on<{ maximized: boolean }>(CH.windowStateChanged, cb),
    onMenuAction: (cb) => on<MenuAction>(CH.menuAction, cb),
  },
};

contextBridge.exposeInMainWorld("logos", api);
