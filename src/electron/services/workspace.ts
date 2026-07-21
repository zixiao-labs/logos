import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CH } from "../../shared/channels";
import type { ServiceContext } from "./context";
import { WorkspaceAccessController } from "./workspace-access";

interface WorkspaceState {
  root: string | null;
  recent: string[];
}

interface WorkspaceDialog {
  showOpenDialog(
    window: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<OpenDialogReturnValue>;
  showSaveDialog(
    window: BrowserWindow,
    options: SaveDialogOptions,
  ): Promise<SaveDialogReturnValue>;
}

export function registerWorkspaceService(
  ctx: ServiceContext,
  dialogService: WorkspaceDialog,
): () => void {
  const { ipcMain } = ctx;
  const workspaceAccess = ctx.workspaceAccess ?? new WorkspaceAccessController();
  ctx.workspaceAccess = workspaceAccess;
  const file = path.join(ctx.userDataDir, "workspace.json");
  let state: WorkspaceState = { root: null, recent: [] };
  let loaded = false;

  async function load(): Promise<WorkspaceState> {
    if (loaded) return state;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
        root?: unknown;
        recent?: unknown;
      };
      const recent = Array.isArray(parsed.recent)
        ? parsed.recent.filter(
            (candidate): candidate is string =>
              typeof candidate === "string" && path.isAbsolute(candidate),
          ).slice(0, 10)
        : [];
      const root =
        typeof parsed.root === "string" && path.isAbsolute(parsed.root)
          ? parsed.root
          : null;
      state = { root, recent };
    } catch {
      state = { root: null, recent: [] };
    }
    try {
      state.root = await workspaceAccess.restoreWorkspaceRoot(state.root);
    } catch {
      state.root = await workspaceAccess.restoreWorkspaceRoot(null);
    }
    const canonicalRecent: string[] = [];
    for (const candidate of state.recent) {
      try {
        const canonical = await workspaceAccess.canonicalize(candidate);
        if (!canonicalRecent.includes(canonical)) canonicalRecent.push(canonical);
      } catch {
        // Drop malformed or unavailable recent workspace entries.
      }
    }
    state.recent = canonicalRecent.slice(0, 10);
    loaded = true;
    return state;
  }

  async function persist() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }

  async function setRoot(root: string | null, allowNew = false) {
    await load();
    let canonical: string | null = null;
    if (root) {
      canonical = await workspaceAccess.canonicalize(root);
      if (!allowNew) {
        const allowed = state.recent.some(candidate => candidate === canonical);
        if (!allowed) {
          throw new Error("Workspace roots must be selected with the native folder dialog.");
        }
      }
      canonical = await workspaceAccess.restoreWorkspaceRoot(canonical);
    } else {
      await workspaceAccess.restoreWorkspaceRoot(null);
    }
    state.root = canonical;
    if (canonical) {
      state.recent = [canonical, ...state.recent.filter((r) => r !== canonical)].slice(
        0,
        10,
      );
    }
    await persist();
    ctx.send(CH.workspaceChanged, canonical);
  }

  const initialization = load();
  workspaceAccess.setInitialization(initialization);

  ipcMain.handle(CH.workspaceGetRoot, async () => (await load()).root);
  ipcMain.handle(CH.workspaceSetRoot, (_e, root: string) => setRoot(root));
  ipcMain.handle(CH.workspaceRecent, async () => (await load()).recent);

  ipcMain.handle(CH.dialogOpenFolder, async () => {
    const win = ctx.getWindow();
    const res = await dialogService.showOpenDialog(win!, {
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    await setRoot(res.filePaths[0], true);
    return state.root;
  });

  ipcMain.handle(CH.dialogOpenFile, async () => {
    const win = ctx.getWindow();
    const res = await dialogService.showOpenDialog(win!, {
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return workspaceAccess.grantPath(res.filePaths[0]);
  });

  ipcMain.handle(CH.dialogSaveFile, async (_e, defaultPath?: string) => {
    const win = ctx.getWindow();
    const res = await dialogService.showSaveDialog(win!, { defaultPath });
    if (res.canceled || !res.filePath) return null;
    return workspaceAccess.grantPath(res.filePath);
  });

  return () => undefined;
}
