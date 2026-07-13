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
  const file = path.join(ctx.userDataDir, "workspace.json");
  let state: WorkspaceState = { root: null, recent: [] };
  let loaded = false;

  async function load(): Promise<WorkspaceState> {
    if (loaded) return state;
    try {
      state = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      state = { root: null, recent: [] };
    }
    loaded = true;
    return state;
  }

  async function persist() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }

  async function setRoot(root: string | null) {
    await load();
    state.root = root;
    if (root) {
      state.recent = [root, ...state.recent.filter((r) => r !== root)].slice(
        0,
        10,
      );
    }
    await persist();
    ctx.send(CH.workspaceChanged, root);
  }

  ipcMain.handle(CH.workspaceGetRoot, async () => (await load()).root);
  ipcMain.handle(CH.workspaceSetRoot, (_e, root: string) => setRoot(root));
  ipcMain.handle(CH.workspaceRecent, async () => (await load()).recent);

  ipcMain.handle(CH.dialogOpenFolder, async () => {
    const win = ctx.getWindow();
    const res = await dialogService.showOpenDialog(win!, {
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    await setRoot(res.filePaths[0]);
    return res.filePaths[0];
  });

  ipcMain.handle(CH.dialogOpenFile, async () => {
    const win = ctx.getWindow();
    const res = await dialogService.showOpenDialog(win!, {
      properties: ["openFile"],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle(CH.dialogSaveFile, async (_e, defaultPath?: string) => {
    const win = ctx.getWindow();
    const res = await dialogService.showSaveDialog(win!, { defaultPath });
    return res.canceled ? null : (res.filePath ?? null);
  });

  return () => undefined;
}
