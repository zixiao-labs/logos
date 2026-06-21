/**
 * Centralised IPC channel names. Both the main process and the preload bridge
 * import these so the wire protocol never drifts.
 */

export const CH = {
  // file system (invoke)
  fsReadDir: "fs:readDir",
  fsReadFile: "fs:readFile",
  fsWriteFile: "fs:writeFile",
  fsStat: "fs:stat",
  fsCreateFile: "fs:createFile",
  fsCreateDir: "fs:createDir",
  fsRename: "fs:rename",
  fsDelete: "fs:delete",
  fsExists: "fs:exists",
  fsWatch: "fs:watch",
  fsUnwatch: "fs:unwatch",
  fsWatchEvent: "fs:watchEvent", // push

  // dialogs (invoke)
  dialogOpenFolder: "dialog:openFolder",
  dialogOpenFile: "dialog:openFile",
  dialogSaveFile: "dialog:saveFile",

  // workspace
  workspaceGetRoot: "workspace:getRoot",
  workspaceSetRoot: "workspace:setRoot",
  workspaceRecent: "workspace:recent",
  workspaceChanged: "workspace:changed", // push

  // git (invoke)
  gitStatus: "git:status",
  gitStage: "git:stage",
  gitUnstage: "git:unstage",
  gitDiscard: "git:discard",
  gitCommit: "git:commit",
  gitCommitAmend: "git:commitAmend",
  gitHead: "git:head",
  gitUndoLastCommit: "git:undoLastCommit",
  gitBranches: "git:branches",
  gitCheckout: "git:checkout",
  gitCreateBranch: "git:createBranch",
  gitDiff: "git:diff",
  gitLog: "git:log",
  gitInit: "git:init",
  gitFetch: "git:fetch",
  gitPull: "git:pull",
  gitPush: "git:push",
  gitSync: "git:sync",

  // terminal
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data", // push (per-id payload)
  terminalExit: "terminal:exit", // push

  // settings
  settingsGetAll: "settings:getAll",
  settingsSet: "settings:set",
  settingsReset: "settings:reset",
  settingsGetPath: "settings:getPath",
  settingsChanged: "settings:changed", // push

  // agent
  agentStart: "agent:start",
  agentInterrupt: "agent:interrupt",
  agentRespondPermission: "agent:respondPermission",
  agentRespondAsk: "agent:respondAsk",
  agentListModels: "agent:listModels",
  agentListCommands: "agent:listCommands",
  agentEvent: "agent:event", // push

  // language servers
  lspList: "lsp:list",
  lspInstall: "lsp:install",
  lspUninstall: "lsp:uninstall",
  lspStart: "lsp:start",
  lspStop: "lsp:stop",
  lspRequest: "lsp:request",
  lspProgress: "lsp:progress", // push
  lspNotify: "lsp:notify", // push (server -> client notifications, e.g. diagnostics)

  // app / window
  appVersions: "app:versions",
  appPlatform: "app:platform",
  windowControl: "window:control",
  windowStateChanged: "window:stateChanged", // push
  menuAction: "app:menuAction", // push (native menu -> renderer)
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];
