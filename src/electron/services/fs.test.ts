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
import type {
  ConditionalWriteResult,
  DirListing,
  FileSnapshot,
  FileStat,
} from "../../shared/types";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerFsService } from "./fs";
import { WorkspaceAccessController } from "./workspace-access";

describe("filesystem service", () => {
  let root: string;
  let cleanup: () => void;
  let service: ReturnType<typeof createIpcHarness>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "logos-fs-"));
    service = createIpcHarness();
    const workspaceAccess = new WorkspaceAccessController();
    await workspaceAccess.restoreWorkspaceRoot(root);
    cleanup = registerFsService({
      ipcMain: service.ipcMain,
      userDataDir: root,
      getWindow: () => null,
      isTrustedSender: () => true,
      workspaceAccess,
      send: () => undefined,
    } satisfies ServiceContext);
  });

  afterEach(async () => {
    cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists directories first, sorts names, and skips heavy directories", async () => {
    await Promise.all([
      fs.mkdir(path.join(root, "beta")),
      fs.mkdir(path.join(root, ".git")),
      fs.mkdir(path.join(root, "node_modules")),
      fs.writeFile(path.join(root, "zeta.txt"), "z"),
      fs.writeFile(path.join(root, "Alpha.txt"), "a"),
      fs.writeFile(path.join(root, ".DS_Store"), "metadata"),
    ]);

    const listing = await service.invoke<DirListing>(CH.fsReadDir, root);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "beta",
      "Alpha.txt",
      "zeta.txt",
    ]);
    expect(listing.entries.map((entry) => entry.type)).toEqual([
      "directory",
      "file",
      "file",
    ]);
  });

  it("writes, reads, stats, renames, and deletes files", async () => {
    const original = path.join(root, "nested", "file.txt");
    const renamed = path.join(root, "nested", "renamed.txt");
    await service.invoke(CH.fsWriteFile, original, "content");

    expect(await service.invoke<string>(CH.fsReadFile, original)).toBe("content");
    expect(await service.invoke<boolean>(CH.fsExists, original)).toBe(true);
    expect(await service.invoke<FileStat>(CH.fsStat, original)).toMatchObject({
      path: await fs.realpath(original),
      type: "file",
      size: 7,
    });

    await service.invoke(CH.fsRename, original, renamed);
    expect(await service.invoke<boolean>(CH.fsExists, original)).toBe(false);
    expect(await service.invoke<boolean>(CH.fsExists, renamed)).toBe(true);

    await service.invoke(CH.fsDelete, path.join(root, "nested"));
    expect(await service.invoke<boolean>(CH.fsExists, renamed)).toBe(false);
  });

  it("creates files exclusively and creates directories recursively", async () => {
    const directory = path.join(root, "one", "two");
    const file = path.join(directory, "new.txt");
    await service.invoke(CH.fsCreateDir, directory);
    await service.invoke(CH.fsCreateFile, file, "new");

    expect(await service.invoke<string>(CH.fsReadFile, file)).toBe("new");
    await expect(service.invoke(CH.fsCreateFile, file, "replace")).rejects.toThrow();
  });

  it("optimistically detects conflicts and serializes local writes", async () => {
    const file = path.join(root, "conditional.txt");
    await fs.writeFile(file, "initial");
    if (process.platform !== "win32") await fs.chmod(file, 0o755);
    const snapshot = await service.invoke<FileSnapshot>(CH.fsReadFileSnapshot, file);

    await fs.writeFile(file, "external");
    const conflict = await service.invoke<ConditionalWriteResult>(
      CH.fsWriteFileConditional,
      file,
      "editor",
      snapshot.revision,
    );
    expect(conflict).toMatchObject({
      status: "conflict",
      current: { exists: true, content: "external" },
    });
    expect(await fs.readFile(file, "utf8")).toBe("external");

    if (conflict.status !== "conflict") throw new Error("Expected a conflict");
    const written = await service.invoke<ConditionalWriteResult>(
      CH.fsWriteFileConditional,
      file,
      "editor",
      conflict.current.revision,
    );
    expect(written.status).toBe("written-optimistically");
    expect(await fs.readFile(file, "utf8")).toBe("editor");
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
    }

    const nextSnapshot = await service.invoke<FileSnapshot>(
      CH.fsReadFileSnapshot,
      file,
    );
    const concurrent = await Promise.all(
      ["first", "second"].map(async (payload) => ({
        payload,
        result: await service.invoke<ConditionalWriteResult>(
          CH.fsWriteFileConditional,
          file,
          payload,
          nextSnapshot.revision,
        ),
      })),
    );
    const winners = concurrent.filter(
      ({ result }) => result.status === "written-optimistically",
    );
    const losers = concurrent.filter(({ result }) => result.status === "conflict");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0];
    const loser = losers[0];
    if (!winner || !loser) throw new Error("Expected one writer and one conflict");
    const persisted = await fs.readFile(file, "utf8");
    expect(persisted).toBe(winner.payload);
    expect(persisted).not.toBe(loser.payload);
  });
});
