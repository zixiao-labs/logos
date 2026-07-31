import { afterEach, beforeEach, describe, expect, it } from "@lightning-js/lightning";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CH } from "../../shared/channels";
import type { ExtensionRegistrySnapshot } from "../../shared/extensions";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerExtensionService, satisfiesLogosEngine } from "./extensions";

interface ZipEntry {
  name: string;
  body: Buffer;
  mode?: number;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.body.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.body.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.body.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function manifest(runtime: Record<string, unknown> = { kind: "declarative" }) {
  return {
    schemaVersion: 1,
    name: "sample",
    publisher: "example",
    version: "1.0.0",
    displayName: "Sample",
    description: "A sample extension",
    engines: { logos: "^1.0.0" },
    logos: {
      runtime,
      contributes: { languages: [{ id: "sample", extensions: [".sample"] }] },
    },
  };
}

async function makeWritable(root: string): Promise<void> {
  let entries;
  try {
    await fs.chmod(root, 0o700);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await makeWritable(path.join(root, entry.name));
  }
}

describe("extension registry and installer", () => {
  let registryDir: string;
  let userDataDir: string;

  beforeEach(async () => {
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-extension-registry-"));
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-extension-data-"));
  });

  afterEach(async () => {
    await makeWritable(userDataDir);
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function setup(
    archiveEntries: ZipEntry[],
    indexOverrides: Record<string, unknown> = {},
  ) {
    const archive = zip(archiveEntries);
    const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    await fs.mkdir(path.join(registryDir, "packages"));
    await fs.writeFile(path.join(registryDir, "packages", "sample.zip"), archive);
    await fs.writeFile(
      path.join(registryDir, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            id: "example.sample",
            version: "1.0.0",
            archive: "packages/sample.zip",
            digest,
            ...indexOverrides,
          },
        ],
      }),
    );
    const ipc = createIpcHarness();
    registerExtensionService({
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: () => undefined,
      appVersion: "1.4.0",
      extensionRegistryDir: registryDir,
      isPackaged: false,
      isTrustedSender: () => true,
    } satisfies ServiceContext);
    return { ipc, digest };
  }

  it("installs a verified declarative package by content digest and collects it on removal", async () => {
    const body = Buffer.from(JSON.stringify(manifest()));
    const { ipc, digest } = await setup([{ name: "extension.json", body }]);

    const available = await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList);
    expect(available).toMatchObject({
      status: "ready",
      extensions: [
        {
          id: "example.sample",
          compatibility: "safe-compatible",
          installed: false,
          installable: true,
        },
      ],
    });
    expect(
      await fs
        .stat(path.join(userDataDir, "extensions", "registry-scan"))
        .then(() => "exists", error => (error as NodeJS.ErrnoException).code),
    ).toBe("ENOENT");

    const installed = await ipc.invoke<ExtensionRegistrySnapshot>(
      CH.extensionsInstall,
      "example.sample",
    );
    const content = path.join(userDataDir, "extensions", "content", digest.slice(7));
    expect({
      installed: installed.extensions[0]?.installed,
      manifest: JSON.parse(await fs.readFile(path.join(content, "extension.json"), "utf8")),
      marker: JSON.parse(await fs.readFile(path.join(content, ".logos-package.json"), "utf8")),
    }).toEqual({
      installed: true,
      manifest: manifest(),
      marker: {
        schemaVersion: 1,
        id: "example.sample",
        version: "1.0.0",
        digest,
      },
    });

    const removed = await ipc.invoke<ExtensionRegistrySnapshot>(
      CH.extensionsUninstall,
      "example.sample",
    );
    expect({
      installed: removed.extensions[0]?.installed,
      cachedContent: await fs
        .stat(content)
        .then(() => "exists", error => (error as NodeJS.ErrnoException).code),
    }).toEqual({ installed: false, cachedContent: "ENOENT" });
  });

  it("reports executable runtimes but fails closed when installation is requested", async () => {
    const body = Buffer.from(JSON.stringify(manifest({ kind: "vscode-node", entry: "main.js" })));
    const { ipc } = await setup([
      { name: "extension.json", body },
      { name: "main.js", body: Buffer.from("throw new Error('must not run')") },
    ]);

    const available = await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList);
    expect(available.extensions[0]).toMatchObject({
      runtime: "vscode-node",
      compatibility: "blocked",
      installable: false,
    });
    await expect(
      ipc.invoke(CH.extensionsInstall, "example.sample"),
    ).rejects.toThrow("blocked");
  });

  it("caches a validated listing manifest by package digest", async () => {
    const body = Buffer.from(JSON.stringify(manifest()));
    const { ipc } = await setup([{ name: "extension.json", body }]);

    expect(await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "ready",
      extensions: [{ id: "example.sample" }],
    });
    await fs.rm(path.join(registryDir, "packages", "sample.zip"));
    expect(await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "ready",
      extensions: [{ id: "example.sample" }],
    });
  });

  it("verifies the registry digest before listing and defers archive checks to install", async () => {
    const declarative = Buffer.from(JSON.stringify(manifest()));
    const digestMismatch = await setup(
      [{ name: "extension.json", body: declarative }],
      { digest: `sha256:${"0".repeat(64)}` },
    );
    // Listing renders permissions and a compatibility verdict, so it must not
    // read them out of an archive the index digest does not cover.
    expect(await digestMismatch.ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "invalid",
      extensions: [],
      message: expect.stringContaining("digest mismatch"),
    });
    await expect(digestMismatch.ipc.invoke(CH.extensionsInstall, "example.sample")).rejects.toThrow(
      "digest mismatch",
    );

    await fs.rm(registryDir, { recursive: true, force: true });
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-extension-registry-"));
    const identityMismatch = await setup(
      [{ name: "extension.json", body: declarative }],
      { id: "other.sample" },
    );
    expect(await identityMismatch.ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "invalid",
    });

    await fs.rm(registryDir, { recursive: true, force: true });
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-extension-registry-"));
    const missingResource = await setup([
      {
        name: "extension.json",
        body: Buffer.from(
          JSON.stringify(manifest({ kind: "wasm-component", entry: "missing.wasm", world: "x:y/z@1.0.0" })),
        ),
      },
    ]);
    expect(await missingResource.ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "ready",
      extensions: [{ id: "example.sample", compatibility: "blocked" }],
    });
    await expect(missingResource.ipc.invoke(CH.extensionsInstall, "example.sample")).rejects.toThrow(
      "missing package resource",
    );

    await fs.rm(registryDir, { recursive: true, force: true });
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-extension-registry-"));
    const traversal = await setup([
      { name: "extension.json", body: declarative },
      { name: "../escape", body: Buffer.from("escape") },
    ]);
    expect(await traversal.ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "ready",
    });
    await expect(traversal.ipc.invoke(CH.extensionsInstall, "example.sample")).rejects.toThrow(
      "path",
    );

    await fs.rm(registryDir, { recursive: true, force: true });
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-extension-registry-"));
    const symlink = await setup([
      { name: "extension.json", body: declarative },
      { name: "link", body: Buffer.from("/etc/passwd"), mode: 0o120777 },
    ]);
    expect(await symlink.ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toMatchObject({
      status: "ready",
    });
    await expect(symlink.ipc.invoke(CH.extensionsInstall, "example.sample")).rejects.toThrow(
      "link or special file",
    );
  });

  it("collects unreferenced content without touching an installed digest", async () => {
    const body = Buffer.from(JSON.stringify(manifest()));
    const { ipc, digest } = await setup([{ name: "extension.json", body }]);
    await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsInstall, "example.sample");

    // Stand in for content an interrupted install left behind: read-only, like
    // the real store, and referenced by no pointer.
    const contentDir = path.join(userDataDir, "extensions", "content");
    const orphan = path.join(contentDir, "a".repeat(64));
    await fs.mkdir(path.join(orphan, "nested"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(orphan, "nested", "leftover.txt"), "stale", { mode: 0o444 });
    await fs.chmod(path.join(orphan, "nested"), 0o555);
    await fs.chmod(orphan, 0o555);

    await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsUninstall, "other.thing");

    const exists = (target: string) =>
      fs.stat(target).then(() => true, () => false);
    expect({
      orphan: await exists(orphan),
      installed: await exists(path.join(contentDir, digest.slice(7))),
    }).toEqual({ orphan: false, installed: true });
  });

  it("does not expose the development registry in packaged mode", async () => {
    const ipc = createIpcHarness();
    registerExtensionService({
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: () => undefined,
      appVersion: "1.4.0",
      extensionRegistryDir: registryDir,
      isPackaged: true,
      isTrustedSender: () => true,
    } satisfies ServiceContext);

    expect(await ipc.invoke<ExtensionRegistrySnapshot>(CH.extensionsList)).toEqual({
      status: "missing",
      source: "local-development",
      extensions: [],
      message: "The local development extension registry is unavailable.",
    });
  });

  it("rejects extension IPC from a sender other than the workbench main frame", async () => {
    const ipc = createIpcHarness();
    registerExtensionService({
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: () => undefined,
      appVersion: "1.4.0",
      extensionRegistryDir: registryDir,
      isPackaged: false,
      isTrustedSender: () => false,
    } satisfies ServiceContext);

    await expect(ipc.invoke(CH.extensionsList)).rejects.toThrow("main frame");
  });
});

describe("extension engine compatibility", () => {
  it("supports exact, tilde, and caret ranges without accepting unsupported syntax", () => {
    expect({
      exact: satisfiesLogosEngine("1.4.0", "1.4.0"),
      exactMismatch: satisfiesLogosEngine("1.3.0", "1.4.0"),
      tilde: satisfiesLogosEngine("~1.3.0", "1.3.9"),
      tildeMismatch: satisfiesLogosEngine("~1.3.0", "1.4.0"),
      caret: satisfiesLogosEngine("^1.0.0", "1.4.0"),
      zeroCaret: satisfiesLogosEngine("^0.2.0", "0.2.8"),
      future: satisfiesLogosEngine("^2.0.0", "1.4.0"),
      unsupported: satisfiesLogosEngine(">=1.0.0", "1.4.0"),
      unsupportedUnion: satisfiesLogosEngine("1.4.0 || 2.0.0", "1.4.0"),
    }).toEqual({
      exact: true,
      exactMismatch: false,
      tilde: true,
      tildeMismatch: false,
      caret: true,
      zeroCaret: true,
      future: false,
      unsupported: false,
      unsupportedUnion: false,
    });
  });
});
