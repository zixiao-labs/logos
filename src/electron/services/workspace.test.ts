import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CH } from "../../shared/channels";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerWorkspaceService } from "./workspace";
import { WorkspaceAccessController } from "./workspace-access";

describe("workspace service", () => {
  let userDataDir: string;
  let openResult: { canceled: boolean; filePaths: string[] };
  let saveResult: { canceled: boolean; filePath?: string };
  let saveDefaultPath: string | undefined;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-workspace-"));
    openResult = { canceled: true, filePaths: [] };
    saveResult = { canceled: true };
    saveDefaultPath = undefined;
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  function setup() {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    const workspaceAccess = new WorkspaceAccessController();
    const ctx = {
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      isTrustedSender: () => true,
      workspaceAccess,
      send: (channel: string, ...args: unknown[]) => sent.push([channel, ...args]),
    } satisfies ServiceContext;
    const dialogService = {
      showOpenDialog: async () => openResult,
      showSaveDialog: async (
        _window: unknown,
        options: { defaultPath?: string },
      ) => {
        saveDefaultPath = options.defaultPath;
        return saveResult;
      },
    } as unknown as typeof import("electron").dialog;
    registerWorkspaceService(ctx, dialogService);
    return { ...ipc, sent };
  }

  it("loads safe defaults for missing and corrupt state", async () => {
    let service = setup();
    expect(await service.invoke(CH.workspaceGetRoot)).toBeNull();
    expect(await service.invoke(CH.workspaceRecent)).toEqual([]);

    await fs.writeFile(
      path.join(userDataDir, "workspace.json"),
      "not-json",
      "utf8",
    );
    service = setup();
    expect(await service.invoke(CH.workspaceGetRoot)).toBeNull();
  });

  it("persists the root and keeps ten unique recent workspaces", async () => {
    const service = setup();
    const roots: string[] = [];
    for (let index = 1; index <= 12; index++) {
      const root = path.join(userDataDir, "workspaces", String(index));
      await fs.mkdir(root, { recursive: true });
      roots.push(await fs.realpath(root));
      openResult = { canceled: false, filePaths: [root] };
      await service.invoke(CH.dialogOpenFolder);
    }
    await service.invoke(CH.workspaceSetRoot, roots[4]);

    const recent = await service.invoke<string[]>(CH.workspaceRecent);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe(roots[4]);
    expect(recent.filter((root) => root === roots[4])).toHaveLength(1);
    expect(service.sent.at(-1)).toEqual([
      CH.workspaceChanged,
      roots[4],
    ]);

    const reloaded = setup();
    expect(await reloaded.invoke(CH.workspaceGetRoot)).toBe(roots[4]);
    expect(await reloaded.invoke(CH.workspaceRecent)).toEqual(recent);
  });

  it("handles canceled and selected file dialogs", async () => {
    const service = setup();
    expect(await service.invoke(CH.dialogOpenFolder)).toBeNull();
    expect(await service.invoke(CH.dialogOpenFile)).toBeNull();
    expect(await service.invoke(CH.dialogSaveFile, "/tmp/default.txt")).toBeNull();
    expect(saveDefaultPath).toBe("/tmp/default.txt");

    const selected = path.join(userDataDir, "selected");
    await fs.mkdir(selected);
    const canonicalSelected = await fs.realpath(selected);
    openResult = { canceled: false, filePaths: [canonicalSelected] };
    expect(await service.invoke(CH.dialogOpenFolder)).toBe(canonicalSelected);
    expect(await service.invoke(CH.workspaceGetRoot)).toBe(
      canonicalSelected,
    );
    const selectedFile = path.join(userDataDir, "outside.txt");
    await fs.writeFile(selectedFile, "outside");
    openResult = { canceled: false, filePaths: [selectedFile] };
    expect(await service.invoke(CH.dialogOpenFile)).toBe(await fs.realpath(selectedFile));

    const saved = path.join(userDataDir, "saved.txt");
    saveResult = { canceled: false, filePath: saved };
    expect(await service.invoke(CH.dialogSaveFile)).toBe(
      path.join(await fs.realpath(userDataDir), "saved.txt"),
    );
  });

  it("rejects renderer-selected workspace roots that were not granted", async () => {
    const service = setup();
    const arbitrary = path.join(userDataDir, "arbitrary");
    await fs.mkdir(arbitrary);
    await expect(service.invoke(CH.workspaceSetRoot, arbitrary)).rejects.toThrow(
      "native folder dialog",
    );
  });
});
