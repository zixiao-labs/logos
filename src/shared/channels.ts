/**
 * Centralised IPC channel names. Both the main process and the preload bridge
 * import these so the wire protocol never drifts.
 */

export const CH = {
  // file system (invoke)
  fsReadDir: "fs:readDir",
  fsReadFile: "fs:readFile",
  fsReadFileSnapshot: "fs:readFileSnapshot",
  fsWriteFile: "fs:writeFile",
  fsWriteFileConditional: "fs:writeFileConditional",
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
  gitFileDiff: "git:fileDiff",
  gitLog: "git:log",
  gitBlame: "git:blame",
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
  settingsSetAcpSecret: "settings:setAcpSecret",
  settingsDeleteAcpSecret: "settings:deleteAcpSecret",
  settingsChanged: "settings:changed", // push

  // agent
  agentStart: "agent:start",
  agentInterrupt: "agent:interrupt",
  agentClose: "agent:close",
  agentRespondPermission: "agent:respondPermission",
  agentRespondAsk: "agent:respondAsk",
  agentListModels: "agent:listModels",
  agentListCommands: "agent:listCommands",
  agentSetMode: "agent:setMode",
  agentSetModel: "agent:setModel",
  agentSetConfig: "agent:setConfig",
  agentAuthenticate: "agent:authenticate",
  agentListProviders: "agent:listProviders",
  agentSetProvider: "agent:setProvider",
  agentDisableProvider: "agent:disableProvider",
  agentAuthStatus: "agent:authStatus",
  agentLoginChatGPT: "agent:loginChatGPT",
  agentSetOpenAIKey: "agent:setOpenAIKey",
  agentLogoutOpenAI: "agent:logoutOpenAI",
  agentRegistryList: "agent:registryList",
  agentRegistryResolve: "agent:registryResolve",
  agentEvent: "agent:event", // push

  // language servers
  lspList: "lsp:list",
  lspInstall: "lsp:install",
  lspUninstall: "lsp:uninstall",
  lspStart: "lsp:start",
  lspStop: "lsp:stop",
  lspRequest: "lsp:request",
  lspSendNotification: "lsp:sendNotification",
  lspCancelRequest: "lsp:cancelRequest",
  lspFileOperation: "lsp:fileOperation",
  lspResourceOperation: "lsp:resourceOperation",
  lspDirectoryIsEmpty: "lsp:directoryIsEmpty",
  lspClientRequest: "lsp:clientRequest", // push (server request -> renderer)
  lspClientRequestCancel: "lsp:clientRequestCancel", // push
  lspClientResponse: "lsp:clientResponse",
  lspProgress: "lsp:progress", // push
  lspNotify: "lsp:notify", // push (server -> client notifications, e.g. diagnostics)
  lspLog: "lsp:log", // push (server stderr / installer output)

  // debug adapter protocol
  debugList: "debug:list",
  debugListAdapters: "debug:listAdapters",
  debugStart: "debug:start",
  debugStop: "debug:stop",
  debugRequest: "debug:request",
  debugSetBreakpoints: "debug:setBreakpoints",
  debugEvent: "debug:event", // push

  // app / window
  appVersions: "app:versions",
  appPlatform: "app:platform",
  appOpenExternal: "app:openExternal",
  windowControl: "window:control",
  windowStateChanged: "window:stateChanged", // push
  menuAction: "app:menuAction", // push (native menu -> renderer)
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];
