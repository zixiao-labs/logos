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
import type { DirListing, FileStat } from "../../shared/types";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerFsService } from "./fs";

describe("filesystem service", () => {
  let root: string;
  let cleanup: () => void;
  let service: ReturnType<typeof createIpcHarness>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "logos-fs-"));
    service = createIpcHarness();
    cleanup = registerFsService({
      ipcMain: service.ipcMain,
      userDataDir: root,
      getWindow: () => null,
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
      path: original,
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
});
