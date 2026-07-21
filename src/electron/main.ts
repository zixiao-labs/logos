import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CH, type ChannelName } from "../shared/channels";
import type { WindowControl } from "../shared/types";
import type { ServiceContext } from "./services/context";
import { registerAgentService } from "./services/agent";
import { registerAcpRegistryService } from "./services/acp-registry";
import { registerDebugService } from "./services/debug";
import { registerFsService } from "./services/fs";
import { registerExtensionService } from "./services/extensions";
import { registerGitService } from "./services/git";
import { registerLspService } from "./services/lsp";
import { registerMenu } from "./services/menu";
import { registerSettingsService } from "./services/settings";
import { registerTerminalService } from "./services/terminal";
import { registerWorkspaceService } from "./services/workspace";
import { AcpSecretStore } from "./services/acp-secrets";
import { authorizeDebugConfigurationPaths } from "./services/debug-path-authorization";
import { setupAutoUpdater } from "./services/updater";
import { createSecureIpcMain } from "./services/ipc-security";
import { WorkspaceAccessController } from "./services/workspace-access";
import {
  inlineScriptCspSources,
  normalizeExternalUrl,
  workbenchContentSecurityPolicy,
} from "./services/workbench-security";

let mainWindow: BrowserWindow | null = null;
const disposers: Array<() => void | Promise<void>> = [];
let shutdownStarted = false;

const GIT_ROOT_CHANNELS = new Set<ChannelName>([
  CH.gitStatus,
  CH.gitStage,
  CH.gitUnstage,
  CH.gitDiscard,
  CH.gitCommit,
  CH.gitCommitAmend,
  CH.gitHead,
  CH.gitUndoLastCommit,
  CH.gitBranches,
  CH.gitCheckout,
  CH.gitCreateBranch,
  CH.gitDiff,
  CH.gitFileDiff,
  CH.gitLog,
  CH.gitGraph,
  CH.gitBlame,
  CH.gitInit,
  CH.gitFetch,
  CH.gitPull,
  CH.gitPush,
  CH.gitSync,
]);
const GIT_PATH_LIST_CHANNELS = new Set<ChannelName>([
  CH.gitStage,
  CH.gitUnstage,
  CH.gitDiscard,
]);

async function authorizeWorkbenchRequest(
  workspaceAccess: WorkspaceAccessController,
  channel: ChannelName,
  args: readonly unknown[],
): Promise<void> {
  if (channel === CH.gitWatch) {
    for (const root of args[0] as string[]) {
      await workspaceAccess.assertWorkspaceRoot(root);
    }
    return;
  }
  if (GIT_ROOT_CHANNELS.has(channel)) {
    const root = String(args[0]);
    await workspaceAccess.assertWorkspaceRoot(root);
    if (GIT_PATH_LIST_CHANNELS.has(channel)) {
      for (const candidate of args[1] as string[]) {
        await workspaceAccess.assertPath(path.resolve(root, candidate), "write");
      }
    } else if (channel === CH.gitDiff || channel === CH.gitFileDiff) {
      await workspaceAccess.assertPath(path.resolve(root, String(args[1])));
    } else if (channel === CH.gitBlame) {
      await workspaceAccess.assertPath(String(args[1]));
    }
    return;
  }

  if (channel === CH.terminalCreate) {
    const options = args[0] as { cwd?: string };
    const cwd = options.cwd ?? workspaceAccess.currentRoot();
    if (!cwd) throw new Error("A workspace must be open before creating a terminal.");
    await workspaceAccess.assertPath(cwd);
    return;
  }
  if (channel === CH.agentStart) {
    const request = args[0] as { cwd: string; additionalDirectories?: string[] };
    await workspaceAccess.assertWorkspaceRoot(request.cwd);
    for (const directory of request.additionalDirectories ?? []) {
      await workspaceAccess.assertWorkspaceRoot(directory);
    }
    return;
  }
  if (channel === CH.agentListModels || channel === CH.agentListCommands) {
    const cwd = (args[0] as { cwd?: string } | undefined)?.cwd;
    if (cwd) await workspaceAccess.assertWorkspaceRoot(cwd);
    return;
  }
  if (channel === CH.lspStart) {
    await workspaceAccess.assertWorkspaceRoot(String(args[1]));
    return;
  }
  if (channel === CH.lspDirectoryIsEmpty) {
    await workspaceAccess.assertPath(String(args[0]));
    return;
  }
  if (channel === CH.lspResourceOperation) {
    const operation = args[0] as {
      kind: "create" | "rename" | "delete";
      path?: string;
      from?: string;
      to?: string;
    };
    if (operation.path) await workspaceAccess.assertPath(operation.path, "write");
    if (operation.from) await workspaceAccess.assertPath(operation.from, "write");
    if (operation.to) await workspaceAccess.assertPath(operation.to, "write");
    return;
  }
  if (channel === CH.lspFileOperation) {
    const payload = args[1] as {
      paths?: string[];
      renames?: Array<{ from: string; to: string }>;
    };
    for (const candidate of payload.paths ?? []) {
      await workspaceAccess.assertPath(candidate, "write");
    }
    for (const rename of payload.renames ?? []) {
      await workspaceAccess.assertPath(rename.from, "write");
      await workspaceAccess.assertPath(rename.to, "write");
    }
    return;
  }
  if (channel === CH.debugSetBreakpoints) {
    await workspaceAccess.assertPath(String(args[1]));
    return;
  }
  if (channel === CH.debugStart) {
    const request = args[0] as {
      configuration: Record<string, unknown>;
      initialBreakpoints?: Record<string, unknown>;
    };
    for (const candidate of Object.keys(request.initialBreakpoints ?? {})) {
      await workspaceAccess.assertPath(candidate);
    }
    request.configuration = await authorizeDebugConfigurationPaths(
      workspaceAccess,
      request.configuration,
    );
  }
}

function createContext(): ServiceContext {
  const configuredRegistry = process.env.LOGOS_EXTENSION_REGISTRY?.trim();
  const extensionRegistryDir = app.isPackaged
    ? undefined
    : configuredRegistry && path.isAbsolute(configuredRegistry)
      ? configuredRegistry
      : path.resolve(app.getAppPath(), "..", "extensions");
  const workspaceAccess = new WorkspaceAccessController();
  const isTrustedSender: ServiceContext["isTrustedSender"] = event =>
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame;
  const ctx: ServiceContext = {
    ipcMain,
    getWindow: () => mainWindow,
    send: (channel, ...args) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send(channel, ...args);
    },
    userDataDir: app.getPath("userData"),
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    extensionRegistryDir,
    isTrustedSender,
    workspaceAccess,
  };
  ctx.ipcMain = createSecureIpcMain(ipcMain, {
    isTrustedSender,
    authorize: (channel, args) =>
      authorizeWorkbenchRequest(workspaceAccess, channel, args),
  });
  return ctx;
}

function registerAppHandlers(ctx: ServiceContext) {
  ctx.ipcMain.handle(CH.appVersions, () => ({
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    logos: app.getVersion(),
  }));

  ctx.ipcMain.handle(CH.appPlatform, () => process.platform);
  ctx.ipcMain.handle(CH.appOpenExternal, async (_event, value: string) => {
    const url = normalizeExternalUrl(value);
    const window = ctx.getWindow();
    if (!window) throw new Error("The workbench window is unavailable.");
    const result = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Cancel", "Open Link"],
      defaultId: 0,
      cancelId: 0,
      message: "Open this link in your default application?",
      detail: url,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("External URL opening was cancelled.");
    await shell.openExternal(url);
  });

  ctx.ipcMain.on(CH.windowControl, (_e, action: WindowControl) => {
    if (!mainWindow) return;
    switch (action) {
      case "minimize":
        mainWindow.minimize();
        break;
      case "maximize":
        mainWindow.maximize();
        break;
      case "unmaximize":
        mainWindow.unmaximize();
        break;
      case "close":
        mainWindow.close();
        break;
    }
  });
}

async function createWindow() {
  const devServerUrl = process.env.NASTI_DEV_SERVER_URL;
  const rendererHtmlPath = path.resolve(__dirname, "renderer/index.html");
  const inlineScriptSources = devServerUrl
    ? []
    : inlineScriptCspSources(await fs.readFile(rendererHtmlPath, "utf8"));

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a0c",
    // Frameless with a custom title bar; keep the native traffic lights on mac.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      process.platform === "darwin"
        ? false
        : { color: "#16161a", symbolColor: "#cdd0d6", height: 36 },
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      preload: path.resolve(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", event => event.preventDefault());
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  const contentSecurityPolicy = workbenchContentSecurityPolicy(
    devServerUrl,
    inlineScriptSources,
  );
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      if (
        details.webContentsId !== mainWindow?.webContents.id ||
        details.resourceType !== "mainFrame"
      ) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const responseHeaders = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {}).filter(
          ([name]) => name.toLowerCase() !== "content-security-policy",
        ),
      );
      callback({
        responseHeaders: {
          ...responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy],
        },
      });
    },
  );

  const notifyState = () =>
    mainWindow?.webContents.send(CH.windowStateChanged, {
      maximized: mainWindow.isMaximized(),
    });
  mainWindow.on("maximize", notifyState);
  mainWindow.on("unmaximize", notifyState);

  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(rendererHtmlPath);
  }
  const workbenchUrl = mainWindow.webContents.getURL();
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== workbenchUrl) event.preventDefault();
  });
}

app.whenReady().then(() => {
  const ctx = createContext();
  const acpSecrets = new AcpSecretStore(ctx.userDataDir);
  const disposeDebug = registerDebugService(ctx);
  registerAppHandlers(ctx);
  disposers.push(
    registerWorkspaceService(ctx, dialog),
    registerFsService(ctx),
    registerGitService(ctx),
    registerTerminalService(ctx),
    registerSettingsService(ctx, acpSecrets),
    registerAcpRegistryService(ctx),
    registerExtensionService(ctx),
    registerAgentService(ctx, acpSecrets),
    registerLspService(ctx),
    disposeDebug,
    registerMenu(ctx),
  );
  void createWindow();

  // Background self-update from GitHub Releases (packaged builds only).
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const cleanup = Promise.allSettled(
    disposers.map((dispose) => Promise.resolve().then(dispose)),
  );
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  void Promise.race([cleanup, timeout]).finally(() => app.quit());
});
