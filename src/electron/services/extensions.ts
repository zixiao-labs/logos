import type {
  ExtensionRegistryPackage,
  LogosExtensionManifest,
} from "@logos-editor/extension-api";
import type { IpcMainInvokeEvent } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { CH } from "../../shared/channels";
import type {
  ExtensionCompatibility,
  ExtensionRegistrySnapshot,
  RegistryExtensionInfo,
} from "../../shared/extensions";
import type { ServiceContext } from "./context";
import {
  extensionManifestId,
  normalizeSafePackagePath,
  parseExtensionManifestJson,
  parseExtensionRegistryJson,
} from "./extension-manifest";

const REGISTRY_INDEX = "registry.json";
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const ARCHIVE_MAX_ENTRIES = 5_000;
const ARCHIVE_MAX_DEPTH = 32;
const ARCHIVE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const ARCHIVE_MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
const ARCHIVE_MAX_COMPRESSION_RATIO = 200;
const MANIFEST_ENTRY = "extension.json";
const INSTALL_RECORD_SCHEMA = 1;

interface ArchiveEntryInfo {
  name: string;
  directory: boolean;
}

interface InspectedArchive {
  manifest: LogosExtensionManifest;
  entries: ArchiveEntryInfo[];
}

interface PreparedPackage extends InspectedArchive {
  archivePath: string;
}

interface InstallRecord {
  schemaVersion: 1;
  id: string;
  version: string;
  digest: `sha256:${string}`;
  installedAt: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateExtensionId(id: string): string {
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(id) || id.length > 129) {
    throw new Error("Invalid extension id.");
  }
  return id;
}

function assertTrustedSender(ctx: ServiceContext, event: IpcMainInvokeEvent): void {
  if (ctx.isTrustedSender && !ctx.isTrustedSender(event)) {
    throw new Error("Extension request did not originate from the workbench main frame.");
  }
}

function normalizeArchiveEntryName(value: string): ArchiveEntryInfo {
  const directory = value.endsWith("/");
  const withoutSlash = directory ? value.slice(0, -1) : value;
  const name = normalizeSafePackagePath(withoutSlash, "archive entry");
  if (name.split("/").length > ARCHIVE_MAX_DEPTH) {
    throw new Error("Extension archive path nesting is too deep.");
  }
  return { name, directory };
}

function isUnsafeUnixFileType(entry: yauzl.Entry, directory: boolean): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  if (type === 0) return false;
  return directory ? type !== 0o040000 : type !== 0o100000;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, strictFileNames: true, autoClose: false },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("Unable to open extension archive."));
        else resolve(zip);
      },
    );
  });
}

function openZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Unable to read archive entry."));
      else resolve(stream);
    });
  });
}

async function readZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number,
): Promise<Buffer> {
  const stream = await openZipEntry(zip, entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      stream.destroy(new Error("Extension manifest exceeds its size limit."));
      throw new Error("Extension manifest exceeds its size limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function inspectArchive(file: string): Promise<InspectedArchive> {
  const zip = await openZip(file);
  const names = new Set<string>();
  const entries: ArchiveEntryInfo[] = [];
  let totalBytes = 0;
  let manifestBody: string | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", entry => {
        void (async () => {
          if (entries.length >= ARCHIVE_MAX_ENTRIES) {
            throw new Error("Extension archive contains too many entries.");
          }
          const info = normalizeArchiveEntryName(entry.fileName);
          if (info.name === ".logos-package.json") {
            throw new Error("Extension archive contains a reserved host file.");
          }
          const collisionKey = info.name.normalize("NFC").toLocaleLowerCase("en-US");
          if (names.has(collisionKey)) {
            throw new Error("Extension archive contains duplicate or case-conflicting entries.");
          }
          names.add(collisionKey);
          if (isUnsafeUnixFileType(entry, info.directory)) {
            throw new Error("Extension archive contains a link or special file.");
          }
          if (entry.uncompressedSize > ARCHIVE_MAX_ENTRY_BYTES) {
            throw new Error("Extension archive entry exceeds its size limit.");
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > ARCHIVE_MAX_EXTRACTED_BYTES) {
            throw new Error("Extension archive exceeds its extracted size limit.");
          }
          if (
            entry.uncompressedSize > 4_096 &&
            entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
              ARCHIVE_MAX_COMPRESSION_RATIO
          ) {
            throw new Error("Extension archive compression ratio is unsafe.");
          }
          entries.push(info);
          if (!info.directory && info.name === MANIFEST_ENTRY) {
            manifestBody = (await readZipEntry(zip, entry, 1024 * 1024)).toString("utf8");
          }
          if (!settled) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  if (manifestBody === undefined) {
    throw new Error("Extension archive is missing extension.json at its root.");
  }
  const manifest = parseExtensionManifestJson(manifestBody);
  const files = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name));
  const referenced = [
    ...(manifest.logos.runtime.kind === "declarative"
      ? []
      : [manifest.logos.runtime.entry]),
    ...(manifest.logos.contributes?.languages ?? []).flatMap(item =>
      item.configuration ? [item.configuration] : [],
    ),
    ...(manifest.logos.contributes?.grammars ?? []).map(item => item.path),
    ...(manifest.logos.contributes?.themes ?? []).map(item => item.path),
  ];
  for (const resource of referenced) {
    if (!files.has(resource)) {
      throw new Error(`Extension manifest references a missing package resource: ${resource}`);
    }
  }
  return { manifest, entries };
}

async function sha256File(file: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

async function copyRegistryArchive(
  root: string,
  reference: ExtensionRegistryPackage,
  scanDir: string,
): Promise<string> {
  const rootReal = await fs.realpath(root);
  const requested = path.join(rootReal, ...reference.archive.split("/"));
  let source: string;
  try {
    source = await fs.realpath(requested);
  } catch {
    throw new Error(`Registry package is missing: ${reference.id}`);
  }
  if (!isInside(rootReal, source)) {
    throw new Error("Registry archive resolves outside the registry root.");
  }
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isFile() || sourceStat.size > ARCHIVE_MAX_BYTES) {
    throw new Error("Registry archive is not a regular file within the size limit.");
  }

  await fs.mkdir(scanDir, { recursive: true, mode: 0o700 });
  const copy = path.join(scanDir, `${randomUUID()}.zip`);
  await fs.copyFile(source, copy, fs.constants.COPYFILE_EXCL);
  await fs.chmod(copy, 0o400);
  const copyStat = await fs.stat(copy);
  if (!copyStat.isFile() || copyStat.size !== sourceStat.size || copyStat.size > ARCHIVE_MAX_BYTES) {
    await fs.rm(copy, { force: true });
    throw new Error("Registry archive changed while it was being staged.");
  }
  return copy;
}

async function preparePackage(
  root: string,
  reference: ExtensionRegistryPackage,
  scanDir: string,
): Promise<PreparedPackage> {
  const archivePath = await copyRegistryArchive(root, reference, scanDir);
  try {
    const actualDigest = await sha256File(archivePath);
    if (actualDigest !== reference.digest) {
      throw new Error(`Registry package digest mismatch: ${reference.id}`);
    }
    const inspected = await inspectArchive(archivePath);
    if (
      extensionManifestId(inspected.manifest) !== reference.id ||
      inspected.manifest.version !== reference.version
    ) {
      throw new Error(`Registry package identity mismatch: ${reference.id}`);
    }
    return { archivePath, ...inspected };
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    throw error;
  }
}

function readZipEntries(
  zip: yauzl.ZipFile,
  onEntry: (entry: yauzl.Entry, info: ArchiveEntryInfo) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", entry => {
      void onEntry(entry, normalizeArchiveEntryName(entry.fileName))
        .then(() => {
          if (!settled) zip.readEntry();
        })
        .catch(fail);
    });
    zip.readEntry();
  });
}

async function extractArchive(file: string, destination: string): Promise<void> {
  const zip = await openZip(file);
  try {
    await readZipEntries(zip, async (entry, info) => {
      const target = path.join(destination, ...info.name.split("/"));
      if (!isInside(destination, target)) {
        throw new Error("Extension archive attempted path traversal.");
      }
      if (info.directory) {
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
        return;
      }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const input = await openZipEntry(zip, entry);
      const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
      await pipeline(input, output);
    });
  } finally {
    zip.close();
  }
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(target);
    } else if (entry.isFile()) {
      await fs.chmod(target, 0o444);
    } else {
      throw new Error("Extracted extension contains an unexpected file type.");
    }
  }
  await fs.chmod(root, 0o555);
}

async function removeStagingTree(root: string): Promise<void> {
  let entries;
  try {
    await fs.chmod(root, 0o700);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeStagingTree(path.join(root, entry.name));
    }
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function validateExistingContent(
  target: string,
  reference: ExtensionRegistryPackage,
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Extension content store contains an invalid package target.");
  }
  try {
    const body = await fs.readFile(path.join(target, ".logos-package.json"), "utf8");
    if (Buffer.byteLength(body, "utf8") > 64 * 1024) throw new Error("oversized marker");
    const marker = JSON.parse(body) as Record<string, unknown>;
    if (
      marker.schemaVersion !== 1 ||
      marker.id !== reference.id ||
      marker.version !== reference.version ||
      marker.digest !== reference.digest
    ) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error("Extension content store package marker is invalid.");
  }
  return true;
}

async function writeJsonAtomic(file: string, value: object): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function parseInstallRecord(value: unknown): InstallRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(key =>
      !["schemaVersion", "id", "version", "digest", "installedAt"].includes(key),
    ) ||
    record.schemaVersion !== INSTALL_RECORD_SCHEMA ||
    typeof record.id !== "string" ||
    typeof record.version !== "string" ||
    typeof record.digest !== "string" ||
    typeof record.installedAt !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(record.digest)
  ) {
    return undefined;
  }
  try {
    validateExtensionId(record.id);
  } catch {
    return undefined;
  }
  return record as unknown as InstallRecord;
}

async function loadInstallRecords(recordsDir: string): Promise<Map<string, InstallRecord>> {
  const result = new Map<string, InstallRecord>();
  let names: string[];
  try {
    names = await fs.readdir(recordsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return result;
    throw error;
  }
  if (names.length > 10_000) throw new Error("Extension install database is too large.");
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.json$/.test(name)) continue;
    try {
      const body = await fs.readFile(path.join(recordsDir, name), "utf8");
      if (Buffer.byteLength(body, "utf8") > 64 * 1024) continue;
      const record = parseInstallRecord(JSON.parse(body) as unknown);
      if (record && `${record.id}.json` === name) result.set(record.id, record);
    } catch {
      // A corrupt pointer is ignored; package contents are never executed from it.
    }
  }
  return result;
}

interface VersionTuple {
  major: number;
  minor: number;
  patch: number;
}

function versionTuple(value: string): VersionTuple | undefined {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value,
  );
  if (!match?.groups) return undefined;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}

function compareVersion(left: VersionTuple, right: VersionTuple): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function satisfiesLogosEngine(range: string, currentVersion: string): boolean {
  if (range === "*") return true;
  const current = versionTuple(currentVersion);
  if (!current) return false;
  const operator = range.startsWith("^") || range.startsWith("~") ? range[0] : "";
  const expected = versionTuple(operator ? range.slice(1) : range);
  if (!expected) return false;
  if (!operator) return compareVersion(current, expected) === 0;
  if (compareVersion(current, expected) < 0) return false;
  if (operator === "~") {
    return current.major === expected.major && current.minor === expected.minor;
  }
  if (expected.major > 0) return current.major === expected.major;
  if (expected.minor > 0) {
    return current.major === 0 && current.minor === expected.minor;
  }
  return current.major === 0 && current.minor === 0 && current.patch === expected.patch;
}

function compatibility(
  manifest: LogosExtensionManifest,
  appVersion: string,
): ExtensionCompatibility {
  if (!satisfiesLogosEngine(manifest.engines.logos, appVersion)) return "api-unsupported";
  if (manifest.logos.runtime.kind !== "declarative") return "blocked";
  if ((manifest.logos.permissions?.length ?? 0) > 0) return "requires-authorization";
  return "safe-compatible";
}

function projectExtension(
  reference: ExtensionRegistryPackage,
  manifest: LogosExtensionManifest,
  installed: InstallRecord | undefined,
  appVersion: string,
): RegistryExtensionInfo {
  const status = compatibility(manifest, appVersion);
  return {
    id: reference.id,
    name: manifest.name,
    publisher: manifest.publisher,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    engine: manifest.engines.logos,
    runtime: manifest.logos.runtime.kind,
    digest: reference.digest,
    permissions: (manifest.logos.permissions ?? []).map(item => ({
      id: item.id,
      reason: item.reason,
    })),
    compatibility: status,
    installed: installed !== undefined,
    ...(installed ? { installedVersion: installed.version } : {}),
    installable: status === "safe-compatible",
  };
}

export function registerExtensionService(ctx: ServiceContext): () => void {
  const managedDir = path.join(ctx.userDataDir, "extensions");
  const scanDir = path.join(managedDir, "registry-scan");
  const stagingDir = path.join(managedDir, "staging");
  const contentDir = path.join(managedDir, "content");
  const recordsDir = path.join(managedDir, "installed");
  const installs = new Map<string, Promise<void>>();
  const appVersion = ctx.appVersion ?? "0.0.0";

  async function loadPreparedCatalog(): Promise<{
    root: string;
    packages: Array<{ reference: ExtensionRegistryPackage; prepared: PreparedPackage }>;
  }> {
    if (ctx.isPackaged || !ctx.extensionRegistryDir) {
      throw new Error("The local development extension registry is unavailable.");
    }
    let root: string;
    try {
      root = await fs.realpath(ctx.extensionRegistryDir);
    } catch {
      throw new Error("The local development extension registry does not exist.");
    }
    const requestedIndexPath = path.join(root, REGISTRY_INDEX);
    let indexBody: string;
    try {
      const indexPath = await fs.realpath(requestedIndexPath);
      if (!isInside(root, indexPath)) {
        throw new Error("The extension registry index resolves outside its root.");
      }
      const stat = await fs.stat(indexPath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
        throw new Error("The extension registry index exceeds its size limit.");
      }
      indexBody = await fs.readFile(indexPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error("The local registry has no registry.json index yet.");
      }
      throw error;
    }
    const index = parseExtensionRegistryJson(indexBody);
    const packages: Array<{
      reference: ExtensionRegistryPackage;
      prepared: PreparedPackage;
    }> = [];
    try {
      for (const reference of index.extensions) {
        packages.push({
          reference,
          prepared: await preparePackage(root, reference, scanDir),
        });
      }
      return { root, packages };
    } catch (error) {
      await Promise.all(packages.map(item => fs.rm(item.prepared.archivePath, { force: true })));
      throw error;
    }
  }

  async function snapshot(): Promise<ExtensionRegistrySnapshot> {
    let catalog:
      | Awaited<ReturnType<typeof loadPreparedCatalog>>
      | undefined;
    try {
      catalog = await loadPreparedCatalog();
      const installed = await loadInstallRecords(recordsDir);
      return {
        status: "ready",
        source: "local-development",
        extensions: catalog.packages.map(({ reference, prepared }) =>
          projectExtension(reference, prepared.manifest, installed.get(reference.id), appVersion),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extension registry is invalid.";
      const missing =
        message.includes("does not exist") ||
        message.includes("no registry.json") ||
        message.includes("unavailable");
      return {
        status: missing ? "missing" : "invalid",
        source: "local-development",
        extensions: [],
        message,
      };
    } finally {
      if (catalog) {
        await Promise.all(
          catalog.packages.map(item => fs.rm(item.prepared.archivePath, { force: true })),
        );
      }
    }
  }

  async function install(id: string): Promise<void> {
    validateExtensionId(id);
    const active = installs.get(id);
    if (active) return active;
    const pending = (async () => {
      const catalog = await loadPreparedCatalog();
      try {
        const item = catalog.packages.find(candidate => candidate.reference.id === id);
        if (!item) throw new Error("Unknown extension id.");
        const status = compatibility(item.prepared.manifest, appVersion);
        if (status !== "safe-compatible") {
          throw new Error(
            status === "requires-authorization"
              ? "Extension permissions require an authorization flow that is not available yet."
              : "Executable or incompatible extensions are blocked by the current security policy.",
          );
        }
        const digestHex = item.reference.digest.slice("sha256:".length);
        const contentTarget = path.join(contentDir, digestHex);
        const contentExists = await validateExistingContent(contentTarget, item.reference);
        if (!contentExists) {
          await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
          await fs.mkdir(contentDir, { recursive: true, mode: 0o700 });
          const stage = path.join(stagingDir, randomUUID());
          await fs.mkdir(stage, { mode: 0o700 });
          try {
            await extractArchive(item.prepared.archivePath, stage);
            await writeJsonAtomic(path.join(stage, ".logos-package.json"), {
              schemaVersion: 1,
              id,
              version: item.reference.version,
              digest: item.reference.digest,
            });
            try {
              await fs.rename(stage, contentTarget);
            } catch (error) {
              if (!isNodeError(error) || !["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) {
                throw error;
              }
              await validateExistingContent(contentTarget, item.reference);
            }
            await makeTreeReadOnly(contentTarget);
          } finally {
            await removeStagingTree(stage);
          }
        }
        const record: InstallRecord = {
          schemaVersion: 1,
          id,
          version: item.reference.version,
          digest: item.reference.digest,
          installedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(path.join(recordsDir, `${id}.json`), record);
      } finally {
        await Promise.all(
          catalog.packages.map(item => fs.rm(item.prepared.archivePath, { force: true })),
        );
      }
    })();
    installs.set(id, pending);
    try {
      await pending;
    } finally {
      if (installs.get(id) === pending) installs.delete(id);
    }
  }

  async function uninstall(id: string): Promise<void> {
    validateExtensionId(id);
    await fs.rm(path.join(recordsDir, `${id}.json`), { force: true });
  }

  ctx.ipcMain.handle(CH.extensionsList, event => {
    assertTrustedSender(ctx, event);
    return snapshot();
  });
  ctx.ipcMain.handle(CH.extensionsInstall, async (event, id: string) => {
    assertTrustedSender(ctx, event);
    await install(id);
    return snapshot();
  });
  ctx.ipcMain.handle(CH.extensionsUninstall, async (event, id: string) => {
    assertTrustedSender(ctx, event);
    await uninstall(id);
    return snapshot();
  });

  return () => {
    ctx.ipcMain.removeHandler(CH.extensionsList);
    ctx.ipcMain.removeHandler(CH.extensionsInstall);
    ctx.ipcMain.removeHandler(CH.extensionsUninstall);
  };
}
