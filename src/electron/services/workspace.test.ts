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
    const ctx = {
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      isTrustedSender: () => true,
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
    for (let index = 1; index <= 12; index++) {
      await service.invoke(CH.workspaceSetRoot, `/workspace/${index}`);
    }
    await service.invoke(CH.workspaceSetRoot, "/workspace/5");

    const recent = await service.invoke<string[]>(CH.workspaceRecent);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe("/workspace/5");
    expect(recent.filter((root) => root === "/workspace/5")).toHaveLength(1);
    expect(service.sent.at(-1)).toEqual([
      CH.workspaceChanged,
      "/workspace/5",
    ]);

    const reloaded = setup();
    expect(await reloaded.invoke(CH.workspaceGetRoot)).toBe("/workspace/5");
    expect(await reloaded.invoke(CH.workspaceRecent)).toEqual(recent);
  });

  it("handles canceled and selected file dialogs", async () => {
    const service = setup();
    expect(await service.invoke(CH.dialogOpenFolder)).toBeNull();
    expect(await service.invoke(CH.dialogOpenFile)).toBeNull();
    expect(await service.invoke(CH.dialogSaveFile, "/tmp/default.txt")).toBeNull();
    expect(saveDefaultPath).toBe("/tmp/default.txt");

    openResult = { canceled: false, filePaths: ["/workspace/selected"] };
    expect(await service.invoke(CH.dialogOpenFolder)).toBe("/workspace/selected");
    expect(await service.invoke(CH.workspaceGetRoot)).toBe(
      "/workspace/selected",
    );
    expect(await service.invoke(CH.dialogOpenFile)).toBe("/workspace/selected");

    saveResult = { canceled: false, filePath: "/tmp/saved.txt" };
    expect(await service.invoke(CH.dialogSaveFile)).toBe("/tmp/saved.txt");
  });
});
