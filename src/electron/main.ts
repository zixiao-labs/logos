import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CH } from "../shared/channels";
import type { WindowControl } from "../shared/types";
import type { ServiceContext } from "./services/context";
import { registerAgentService } from "./services/agent";
import { registerDebugService } from "./services/debug";
import { registerFsService } from "./services/fs";
import { registerGitService } from "./services/git";
import { registerLspService } from "./services/lsp";
import { registerMenu } from "./services/menu";
import { registerSettingsService } from "./services/settings";
import { registerTerminalService } from "./services/terminal";
import { registerWorkspaceService } from "./services/workspace";
import { setupAutoUpdater } from "./services/updater";

let mainWindow: BrowserWindow | null = null;
const disposers: (() => void)[] = [];

function createContext(): ServiceContext {
  return {
    ipcMain,
    getWindow: () => mainWindow,
    send: (channel, ...args) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send(channel, ...args);
    },
    userDataDir: app.getPath("userData"),
    isPackaged: app.isPackaged,
  };
}

function registerAppHandlers() {
  ipcMain.handle(CH.appVersions, () => ({
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    logos: app.getVersion(),
  }));

  ipcMain.handle(CH.appPlatform, () => process.platform);
  ipcMain.handle(CH.appOpenExternal, async (_event, value: string) => {
    const url = new URL(value);
    if (url.protocol === "file:") {
      const error = await shell.openPath(fileURLToPath(url));
      if (error) throw new Error(error);
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
      throw new Error(`Unsupported external URL protocol: ${url.protocol}`);
    }
    await shell.openExternal(url.toString());
  });

  ipcMain.on(CH.windowControl, (_e, action: WindowControl) => {
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
      sandbox: false, // node-pty / SDK run in main; preload needs ipcRenderer
    },
  });

  const notifyState = () =>
    mainWindow?.webContents.send(CH.windowStateChanged, {
      maximized: mainWindow.isMaximized(),
    });
  mainWindow.on("maximize", notifyState);
  mainWindow.on("unmaximize", notifyState);

  if (process.env.NASTI_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.NASTI_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const ctx = createContext();
  registerAppHandlers();
  disposers.push(
    registerFsService(ctx),
    registerGitService(ctx),
    registerTerminalService(ctx),
    registerSettingsService(ctx),
    registerWorkspaceService(ctx, dialog),
    registerAgentService(ctx),
    registerLspService(ctx),
    registerDebugService(ctx),
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

app.on("before-quit", () => {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
});
