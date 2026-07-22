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
import type { WorkspaceSnapshot } from "../../shared/types";
import type { WorkspaceAgentSetupRequest } from "../../shared/types";
import {
  MCP_FILES,
  SKILL_FILES,
  setupWorkspaceAgents,
  workspaceAgentSetupStatus,
} from "./workspace-agent-setup";

interface WorkspaceState {
  folders: string[];
  recent: string[];
}

function skillSetupFiles(): string[] {
  return SKILL_FILES.map(relative =>
    path.join(".agents", "skills", "setup-launch-json", relative)
  );
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
  let state: WorkspaceState = { folders: [], recent: [] };
  let loaded = false;
  let pendingSetFolders: Promise<void> = Promise.resolve();

  const snapshot = (): WorkspaceSnapshot => ({
    folders: [...state.folders],
    root: state.folders[0] ?? null,
  });

  async function load(): Promise<WorkspaceState> {
    if (loaded) return state;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
        folders?: unknown;
        root?: unknown;
        recent?: unknown;
      };
      const recent = Array.isArray(parsed.recent)
        ? parsed.recent.filter(
            (candidate): candidate is string =>
              typeof candidate === "string" && path.isAbsolute(candidate),
          ).slice(0, 10)
        : [];
      const folders = Array.isArray(parsed.folders)
        ? parsed.folders.filter(
            (candidate): candidate is string =>
              typeof candidate === "string" && path.isAbsolute(candidate),
          )
        : typeof parsed.root === "string" && path.isAbsolute(parsed.root)
          ? [parsed.root]
          : [];
      state = { folders, recent };
    } catch {
      state = { folders: [], recent: [] };
    }
    const availableFolders: string[] = [];
    for (const candidate of state.folders) {
      try {
        const canonical = await workspaceAccess.canonicalize(candidate);
        if ((await fs.stat(canonical)).isDirectory() && !availableFolders.includes(canonical)) {
          availableFolders.push(canonical);
        }
      } catch {
        // Drop workspace folders that disappeared since the last launch.
      }
    }
    state.folders = await workspaceAccess.restoreWorkspaceRoots(availableFolders);
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
    await fs.writeFile(
      file,
      JSON.stringify({ ...state, root: state.folders[0] ?? null }, null, 2),
      "utf8",
    );
  }

  function setFolders(folders: readonly string[], allowNew = false): Promise<void> {
    const operation = pendingSetFolders.then(async () => {
      await load();
      const canonicalFolders: string[] = [];
      for (const folder of folders) {
        const canonical = await workspaceAccess.canonicalize(folder);
        if (!allowNew) {
          const allowed =
            state.recent.includes(canonical) || state.folders.includes(canonical);
          if (!allowed) {
            throw new Error("Workspace roots must be selected with the native folder dialog.");
          }
        }
        if (!canonicalFolders.includes(canonical)) canonicalFolders.push(canonical);
      }
      state.folders = await workspaceAccess.restoreWorkspaceRoots(canonicalFolders);
      for (const folder of [...state.folders].reverse()) {
        state.recent = [folder, ...state.recent.filter((recent) => recent !== folder)];
      }
      state.recent = state.recent.slice(0, 10);
      await persist();
      ctx.send(CH.workspaceChanged, snapshot());
    });
    pendingSetFolders = operation.catch(() => undefined);
    return operation;
  }

  const initialization = load();
  workspaceAccess.setInitialization(initialization);

  ipcMain.handle(CH.workspaceGetRoot, async () => (await load()).folders[0] ?? null);
  ipcMain.handle(CH.workspaceGetFolders, async () => [...(await load()).folders]);
  ipcMain.handle(CH.workspaceSetRoot, (_e, root: string) => setFolders([root]));
  ipcMain.handle(CH.workspaceRecent, async () => (await load()).recent);
  ipcMain.handle(CH.workspaceAgentSetupStatus, async (_event, root: string) => {
    const canonical = await workspaceAccess.assertWorkspaceRoot(root);
    for (const relative of [...MCP_FILES, ...skillSetupFiles()]) {
      await workspaceAccess.assertPath(path.join(canonical, relative));
    }
    return workspaceAgentSetupStatus(canonical);
  });
  ipcMain.handle(
    CH.workspaceSetupAgents,
    async (_event, request: WorkspaceAgentSetupRequest) => {
      const root = await workspaceAccess.assertWorkspaceRoot(request.root);
      const skillFiles = skillSetupFiles();
      const writeTargets = [
        ...(request.installMcp ? MCP_FILES : []),
        ...(request.installSkill ? skillFiles : []),
      ];
      for (const relative of [...MCP_FILES, ...skillFiles]) {
        await workspaceAccess.assertPath(path.join(root, relative));
      }
      for (const relative of writeTargets) {
        await workspaceAccess.assertPath(path.join(root, relative), "write");
      }
      const debugMcpServerPath = ctx.debugMcpServerPath ??
        path.resolve("packages/debug-mcp/server.mjs");
      const skillTemplateRoot = path.join(
        ctx.agentSkillsDir ?? path.resolve(".agents/skills"),
        "setup-launch-json",
      );
      return setupWorkspaceAgents(
        { ...request, root },
        { debugMcpServerPath, skillTemplateRoot },
      );
    },
  );

  ipcMain.handle(CH.dialogOpenFolder, async () => {
    const win = ctx.getWindow();
    const res = await dialogService.showOpenDialog(win!, {
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    await setFolders([res.filePaths[0]], true);
    return state.folders[0] ?? null;
  });

  ipcMain.handle(CH.workspaceAddFolder, async () => {
    await load();
    const win = ctx.getWindow();
    const res = await dialogService.showOpenDialog(win!, {
      properties: ["openDirectory", "multiSelections"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    await setFolders([...state.folders, ...res.filePaths], true);
    return snapshot();
  });

  ipcMain.handle(CH.workspaceRemoveFolder, async (_e, folder: string) => {
    await load();
    const canonical = await workspaceAccess.canonicalize(folder);
    if (!state.folders.includes(canonical)) {
      throw new Error("Folder is not part of the current workspace.");
    }
    await setFolders(state.folders.filter(candidate => candidate !== canonical));
    return snapshot();
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
