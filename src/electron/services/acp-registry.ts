import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as extractTar, type ReadEntry } from "tar";
import unbzip2Stream from "unbzip2-stream";
import * as yauzl from "yauzl";
import { CH } from "../../shared/channels";
import type {
  AcpAgentConfig,
  AcpRegistryAgent,
  AcpRegistryDistributionKind,
} from "../../shared/types";
import type { ServiceContext } from "./context";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const ACP_REGISTRY_CACHE_FILE = "acp-registry-cache.json";

const CACHE_FRESH_MS = 5 * 60 * 1_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const REGISTRY_MAX_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
const EXTRACTED_MAX_BYTES = 512 * 1024 * 1024;
const ARCHIVE_MAX_ENTRIES = 20_000;
const ARCHIVE_MAX_DEPTH = 64;
const HTTPS_MAX_REDIRECTS = 5;
const INSTALL_MARKER = ".acp-install.json";

export type AcpPlatform =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

interface ManifestLaunch {
  package: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpRegistryBinary {
  archive: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  sha256: string;
}

export interface ParsedAcpRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  icon?: string;
  distribution: {
    binary?: Partial<Record<AcpPlatform, AcpRegistryBinary>>;
    npx?: ManifestLaunch;
    uvx?: ManifestLaunch;
  };
}

export interface ParsedAcpRegistry {
  version?: string;
  agents: ParsedAcpRegistryAgent[];
}

interface RegistryCache {
  body: string;
  etag?: string;
  fetchedAt: number;
  registry: ParsedAcpRegistry;
}

interface CachedFile {
  body: string;
  etag?: string;
  fetchedAt: number;
}

interface ResolveOptions {
  platform?: AcpPlatform | null;
  runtimePlatform?: NodeJS.Platform;
  installBinary?: (
    agent: ParsedAcpRegistryAgent,
    binary: AcpRegistryBinary,
    platform: AcpPlatform,
  ) => Promise<string>;
  packageManagers?: { npx: boolean; uvx: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function parseArgs(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    return null;
  }
  return [...value];
}

function parseEnv(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  const dangerous = /^(?:PATH|HOME|USERPROFILE|NODE_OPTIONS|LD_PRELOAD|DYLD_.*|NPM_TOKEN|GITHUB_TOKEN|AWS_.*|GOOGLE_.*|AZURE_.*)$/i;
  if (
    !entries.every(
      ([key, item]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        !dangerous.test(key) &&
        typeof item === "string" &&
        !item.includes("\0"),
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

function normalizeSha256(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const digest = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

function isAcpPlatform(value: string): value is AcpPlatform {
  return /^(darwin|linux|windows)-(aarch64|x86_64)$/.test(value);
}

function parsePackageLaunch(value: unknown): ManifestLaunch | undefined {
  if (!isRecord(value) || !nonEmptyString(value.package) || /\s/.test(value.package)) {
    return undefined;
  }
  const args = parseArgs(value.args);
  const env = parseEnv(value.env);
  if (!args || !env) return undefined;
  return { package: value.package, args, env };
}

function parseBinaryLaunch(value: unknown): AcpRegistryBinary | undefined {
  if (!isRecord(value) || !nonEmptyString(value.archive) || !nonEmptyString(value.cmd)) {
    return undefined;
  }
  let archive: URL;
  try {
    archive = new URL(value.archive);
  } catch {
    return undefined;
  }
  if (archive.protocol !== "https:") return undefined;

  let cmd: string;
  try {
    cmd = normalizeSafeCommandPath(value.cmd);
  } catch {
    return undefined;
  }
  const args = parseArgs(value.args);
  const env = parseEnv(value.env);
  const sha256 = normalizeSha256(value.sha256);
  if (!args || !env || !sha256) return undefined;
  return {
    archive: archive.toString(),
    cmd,
    args,
    env,
    sha256,
  };
}

function parseAgent(value: unknown): ParsedAcpRegistryAgent | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !/^[a-z][a-z0-9-]*$/.test(value.id) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.version) ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) ||
    !nonEmptyString(value.description) ||
    !isRecord(value.distribution)
  ) {
    return undefined;
  }

  const distribution: ParsedAcpRegistryAgent["distribution"] = {};
  const npx = parsePackageLaunch(value.distribution.npx);
  const uvx = parsePackageLaunch(value.distribution.uvx);
  if (npx) distribution.npx = npx;
  if (uvx) distribution.uvx = uvx;

  if (isRecord(value.distribution.binary)) {
    const binary: Partial<Record<AcpPlatform, AcpRegistryBinary>> = {};
    for (const [platform, candidate] of Object.entries(value.distribution.binary)) {
      if (!isAcpPlatform(platform)) continue;
      const parsed = parseBinaryLaunch(candidate);
      if (parsed) binary[platform] = parsed;
    }
    if (Object.keys(binary).length > 0) distribution.binary = binary;
  }

  if (!distribution.binary && !distribution.npx && !distribution.uvx) return undefined;
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    description: value.description,
    repository: optionalString(value.repository),
    website: optionalString(value.website),
    icon: optionalString(value.icon),
    distribution,
  };
}

/** Parse the supported registry fields while deliberately ignoring unknown extensions. */
export function parseAcpRegistry(value: unknown): ParsedAcpRegistry {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    throw new Error("Invalid ACP registry: expected an agents array.");
  }
  const seen = new Set<string>();
  const agents: ParsedAcpRegistryAgent[] = [];
  for (const candidate of value.agents) {
    const agent = parseAgent(candidate);
    if (!agent || seen.has(agent.id)) continue;
    seen.add(agent.id);
    agents.push(agent);
  }
  if (value.agents.length > 0 && agents.length === 0) {
    throw new Error("Invalid ACP registry: no valid agent entries.");
  }
  return {
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    agents,
  };
}

export function parseAcpRegistryJson(body: string): ParsedAcpRegistry {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Invalid ACP registry: response is not valid JSON.");
  }
  return parseAcpRegistry(value);
}

export function currentAcpPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AcpPlatform | null {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  const candidate = cpu ? `${os}-${cpu}` : "";
  return isAcpPlatform(candidate) ? candidate : null;
}

function packageManagerAvailability(): { npx: boolean; uvx: boolean } {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    home ? path.join(home, ".local", "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    resourcesPath ? path.join(resourcesPath, "bin") : "",
  ].filter(Boolean);
  const available = (name: string) => {
    const candidates =
      process.platform === "win32"
        ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name]
        : [name];
    return directories.some((directory) =>
      candidates.some((candidate) => existsSync(path.join(directory, candidate))),
    );
  };
  return { npx: available("npx"), uvx: available("uvx") };
}

export function projectAcpRegistryAgents(
  registry: ParsedAcpRegistry,
  platform: AcpPlatform | null = currentAcpPlatform(),
  packageManagers: { npx: boolean; uvx: boolean } = { npx: true, uvx: true },
): AcpRegistryAgent[] {
  return registry.agents.map((agent) => {
    const distributionKinds: AcpRegistryDistributionKind[] = [];
    if (agent.distribution.binary) distributionKinds.push("binary");
    if (agent.distribution.npx) distributionKinds.push("npx");
    if (agent.distribution.uvx) distributionKinds.push("uvx");
    const available = Boolean(
      (agent.distribution.npx && packageManagers.npx) ||
        (agent.distribution.uvx && packageManagers.uvx) ||
        (platform && agent.distribution.binary?.[platform]),
    );
    return {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description,
      ...(agent.repository ? { repository: agent.repository } : {}),
      ...(agent.website ? { website: agent.website } : {}),
      ...(agent.icon ? { icon: agent.icon } : {}),
      distributionKinds,
      available,
      ...(!available
        ? {
            unavailableReason: platform
              ? `No installed package runner or binary is available for ${platform}.`
              : `No launch distribution is available for ${process.platform}/${process.arch}.`,
          }
        : {}),
    };
  });
}

export async function resolveAcpRegistryAgent(
  agent: ParsedAcpRegistryAgent,
  options: ResolveOptions = {},
): Promise<AcpAgentConfig> {
  const platform = options.platform === undefined ? currentAcpPlatform() : options.platform;
  const packageManagers = options.packageManagers ?? { npx: true, uvx: true };
  const binary = platform ? agent.distribution.binary?.[platform] : undefined;
  let binaryError: unknown;
  if (binary && platform) {
    if (!options.installBinary) {
      throw new Error("A binary installer is required for this registry agent.");
    }
    try {
      return {
        id: `registry:${agent.id}`,
        name: agent.name,
        command: await options.installBinary(agent, binary, platform),
        args: [...binary.args],
        env: { ...binary.env },
        authArgsPrefix: [],
      };
    } catch (error) {
      binaryError = error;
      if (!agent.distribution.npx && !agent.distribution.uvx) throw error;
    }
  }

  const runtimePlatform = options.runtimePlatform ?? process.platform;
  if (agent.distribution.npx && packageManagers.npx) {
    const launch = agent.distribution.npx;
    return {
      id: `registry:${agent.id}`,
      name: agent.name,
      command: runtimePlatform === "win32" ? "npx.cmd" : "npx",
      args: ["--yes", launch.package, ...launch.args],
      env: { ...launch.env },
      authArgsPrefix: ["--yes", launch.package],
    };
  }
  if (agent.distribution.uvx && packageManagers.uvx) {
    const launch = agent.distribution.uvx;
    return {
      id: `registry:${agent.id}`,
      name: agent.name,
      command: runtimePlatform === "win32" ? "uvx.exe" : "uvx",
      args: [launch.package, ...launch.args],
      env: { ...launch.env },
      authArgsPrefix: [launch.package],
    };
  }
  if (binaryError) throw binaryError;
  throw new Error(`ACP registry agent ${agent.id} is not available on this platform.`);
}

/** Convert an untrusted archive path into a portable relative path or reject it. */
export function normalizeSafeArchivePath(value: string): string {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`Unsafe absolute archive path: ${value}`);
  }
  const parts = value.replaceAll("\\", "/").split("/");
  const safe: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`Unsafe traversal archive path: ${value}`);
    if (/[<>:"|?*]/.test(part)) throw new Error(`Unsafe archive path: ${value}`);
    safe.push(part);
  }
  return safe.join("/");
}

export function normalizeSafeCommandPath(value: string): string {
  const normalized = normalizeSafeArchivePath(value);
  if (!normalized || normalized === INSTALL_MARKER) {
    throw new Error(`Unsafe binary command path: ${value}`);
  }
  return normalized;
}

async function readResponseLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Response exceeds the ${maxBytes} byte limit.`);
  }
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new Error(`Response exceeds the ${maxBytes} byte limit.`);
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

async function fetchHttps(url: string | URL, init: RequestInit): Promise<Response> {
  let current = new URL(url);
  let redirects = 0;
  while (true) {
    if (current.protocol !== "https:") throw new Error("ACP requests must use HTTPS.");
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.url && new URL(response.url).protocol !== "https:") {
      throw new Error("ACP request redirected to an insecure URL.");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return response;
    if (redirects >= HTTPS_MAX_REDIRECTS) {
      throw new Error("ACP request exceeded the redirect limit.");
    }
    const next = new URL(location, current);
    if (next.protocol !== "https:") {
      throw new Error("ACP request redirected to an insecure URL.");
    }
    current = next;
    redirects += 1;
  }
}

async function downloadBinary(url: string): Promise<Buffer> {
  const response = await fetchHttps(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "Logos" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ACP binary download failed with HTTP ${response.status}.`);
  return readResponseLimited(response, DOWNLOAD_MAX_BYTES);
}

function archiveKind(url: string): "tar" | "tar-bz2" | "zip" | "raw" {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar-bz2";
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar";
  if (pathname.endsWith(".zip")) return "zip";
  return "raw";
}

function tarExtractOptions(cwd: string) {
  let entries = 0;
  let bytes = 0;
  return {
    cwd,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    maxDepth: ARCHIVE_MAX_DEPTH,
    maxDecompressionRatio: 100,
    filter(entryPath: string, rawEntry: ReadEntry | import("node:fs").Stats): boolean {
      const entry = rawEntry as ReadEntry;
      normalizeSafeArchivePath(entryPath);
      if (entry.meta) return true;
      if (!(["File", "OldFile", "ContiguousFile", "Directory"] as string[]).includes(entry.type)) {
        throw new Error(`Refusing archive entry type ${entry.type}.`);
      }
      entries += 1;
      bytes += entry.size;
      if (entries > ARCHIVE_MAX_ENTRIES || bytes > EXTRACTED_MAX_BYTES) {
        throw new Error("ACP binary archive exceeds extraction limits.");
      }
      return true;
    },
  };
}

async function extractTarArchive(data: Buffer, destination: string, bzip2: boolean): Promise<void> {
  const options = tarExtractOptions(destination);
  if (bzip2) {
    await pipeline(Readable.from(data), unbzip2Stream(), extractTar(options));
    return;
  }
  const archive = path.join(path.dirname(destination), `.${randomUUID()}.archive`);
  try {
    await fs.writeFile(archive, data, { flag: "wx" });
    await extractTar({ ...options, file: archive });
  } finally {
    await fs.rm(archive, { force: true }).catch(() => undefined);
  }
}

function zipEntryKind(entry: yauzl.Entry): "file" | "directory" | "symlink" | "special" {
  const madeByUnix = entry.versionMadeBy >> 8 === 3;
  const mode = madeByUnix ? entry.externalFileAttributes >>> 16 : 0;
  const type = mode & 0o170000;
  if (type === 0o120000) return "symlink";
  if (entry.fileName.endsWith("/") || type === 0o040000) return "directory";
  if (type !== 0 && type !== 0o100000) return "special";
  return "file";
}

async function extractZipArchive(data: Buffer, destination: string): Promise<void> {
  const zip = await yauzl.fromBufferPromise(data, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let entries = 0;
  let bytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const relative = normalizeSafeArchivePath(entry.fileName);
      const kind = zipEntryKind(entry);
      if (kind === "symlink" || kind === "special") {
        throw new Error(`Refusing ZIP entry type ${kind}.`);
      }
      if (!relative) continue;
      entries += 1;
      bytes += entry.uncompressedSize;
      if (entries > ARCHIVE_MAX_ENTRIES || bytes > EXTRACTED_MAX_BYTES) {
        throw new Error("ACP binary archive exceeds extraction limits.");
      }

      const target = path.join(destination, ...relative.split("/"));
      if (kind === "directory") {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const input = await zip.openReadStreamPromise(entry);
      await pipeline(input, createWriteStream(target, { flags: "wx", mode: 0o600 }));
    }
  } finally {
    zip.close();
  }
}

async function validateExtractedTree(root: string): Promise<void> {
  let entries = 0;
  let bytes = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > ARCHIVE_MAX_DEPTH) throw new Error("ACP binary archive is nested too deeply.");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const stat = await fs.lstat(item);
      if (stat.isSymbolicLink()) throw new Error("ACP binary archive contains a symbolic link.");
      entries += 1;
      if (entries > ARCHIVE_MAX_ENTRIES) throw new Error("ACP binary archive has too many entries.");
      if (stat.isDirectory()) {
        await walk(item, depth + 1);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > EXTRACTED_MAX_BYTES) throw new Error("ACP binary archive is too large.");
      } else {
        throw new Error("ACP binary archive contains a special file.");
      }
    }
  }
  await walk(root, 0);
}

async function completedInstall(
  target: string,
  agent: ParsedAcpRegistryAgent,
  binary: AcpRegistryBinary,
  platform: AcpPlatform,
): Promise<string | null> {
  try {
    const targetStat = await fs.lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return null;
    const marker = JSON.parse(await fs.readFile(path.join(target, INSTALL_MARKER), "utf8")) as unknown;
    if (
      !isRecord(marker) ||
      marker.id !== agent.id ||
      marker.version !== agent.version ||
      marker.platform !== platform ||
      marker.archive !== binary.archive ||
      marker.sha256 !== binary.sha256 ||
      marker.cmd !== binary.cmd
    ) {
      return null;
    }
    const command = path.join(target, ...binary.cmd.split("/"));
    const commandStat = await fs.lstat(command);
    return commandStat.isFile() && !commandStat.isSymbolicLink() ? command : null;
  } catch {
    return null;
  }
}

async function installBinary(
  userDataDir: string,
  agent: ParsedAcpRegistryAgent,
  binary: AcpRegistryBinary,
  platform: AcpPlatform,
): Promise<string> {
  const parent = path.join(userDataDir, "acp-agents", agent.id, agent.version);
  const target = path.join(parent, platform);
  const existing = await completedInstall(target, agent, binary, platform);
  if (existing) return existing;

  await fs.mkdir(parent, { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  const staging = await fs.mkdtemp(path.join(parent, `.${platform}-`));
  try {
    const data = await downloadBinary(binary.archive);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== binary.sha256) throw new Error("ACP binary download failed SHA-256 verification.");

    const kind = archiveKind(binary.archive);
    if (kind === "zip") {
      await extractZipArchive(data, staging);
    } else if (kind === "tar" || kind === "tar-bz2") {
      await extractTarArchive(data, staging, kind === "tar-bz2");
    } else {
      const command = path.join(staging, ...binary.cmd.split("/"));
      await fs.mkdir(path.dirname(command), { recursive: true });
      await fs.writeFile(command, data, { flag: "wx", mode: 0o700 });
    }

    await validateExtractedTree(staging);
    const command = path.join(staging, ...binary.cmd.split("/"));
    const commandStat = await fs.lstat(command);
    if (!commandStat.isFile() || commandStat.isSymbolicLink()) {
      throw new Error(`ACP binary command was not found: ${binary.cmd}`);
    }
    await fs.chmod(command, 0o755);
    await fs.writeFile(
      path.join(staging, INSTALL_MARKER),
      JSON.stringify(
        {
          id: agent.id,
          version: agent.version,
          platform,
          archive: binary.archive,
          sha256: binary.sha256,
          cmd: binary.cmd,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(staging, target);
    return path.join(target, ...binary.cmd.split("/"));
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCache(file: string): Promise<RegistryCache | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > REGISTRY_MAX_BYTES + 64 * 1024) return null;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      typeof value.body !== "string" ||
      Buffer.byteLength(value.body) > REGISTRY_MAX_BYTES ||
      typeof value.fetchedAt !== "number" ||
      !Number.isFinite(value.fetchedAt) ||
      (value.etag !== undefined &&
        (typeof value.etag !== "string" || value.etag.length > 1_024 || /[\r\n]/.test(value.etag)))
    ) {
      return null;
    }
    const registry = parseAcpRegistryJson(value.body);
    if (!registry.version?.startsWith("1.")) return null;
    return {
      body: value.body,
      ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
      fetchedAt: value.fetchedAt,
      registry,
    };
  } catch {
    return null;
  }
}

async function writeCache(file: string, cache: CachedFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(cache), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function createRegistryLoader(userDataDir: string) {
  const cacheFile = path.join(userDataDir, ACP_REGISTRY_CACHE_FILE);
  return async function load(forceRefresh = false): Promise<ParsedAcpRegistry> {
    const cached = await readCache(cacheFile);
    const now = Date.now();
    if (!forceRefresh && cached && cached.fetchedAt <= now && now - cached.fetchedAt < CACHE_FRESH_MS) {
      return cached.registry;
    }

    try {
      const headers = new Headers({ Accept: "application/json", "User-Agent": "Logos" });
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      const response = await fetchHttps(ACP_REGISTRY_URL, {
        headers,
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (response.status === 304 && cached) {
        await writeCache(cacheFile, {
          body: cached.body,
          ...(response.headers.get("etag") || cached.etag
            ? { etag: response.headers.get("etag") ?? cached.etag }
            : {}),
          fetchedAt: now,
        }).catch(() => undefined);
        return cached.registry;
      }
      if (!response.ok) throw new Error(`ACP registry request failed with HTTP ${response.status}.`);
      const body = (await readResponseLimited(response, REGISTRY_MAX_BYTES)).toString("utf8");
      const registry = parseAcpRegistryJson(body);
      if (!registry.version?.startsWith("1.")) {
        throw new Error(`Unsupported ACP registry schema version: ${registry.version ?? "missing"}`);
      }
      const etag = response.headers.get("etag");
      await writeCache(cacheFile, {
        body,
        ...(etag ? { etag } : {}),
        fetchedAt: now,
      }).catch(() => undefined);
      return registry;
    } catch (error) {
      if (cached) return cached.registry;
      throw error;
    }
  };
}

export function registerAcpRegistryService(ctx: ServiceContext): () => void {
  const loadRegistry = createRegistryLoader(ctx.userDataDir);
  const installs = new Map<string, Promise<string>>();

  function installShared(
    agent: ParsedAcpRegistryAgent,
    binary: AcpRegistryBinary,
    platform: AcpPlatform,
  ): Promise<string> {
    const key = path.join(ctx.userDataDir, "acp-agents", agent.id, agent.version, platform);
    const current = installs.get(key);
    if (current) return current;
    const pending = installBinary(ctx.userDataDir, agent, binary, platform);
    installs.set(key, pending);
    void pending.finally(() => {
      if (installs.get(key) === pending) installs.delete(key);
    }).catch(() => undefined);
    return pending;
  }

  ctx.ipcMain.handle(
    CH.agentRegistryList,
    async (_event, forceRefresh?: boolean): Promise<AcpRegistryAgent[]> =>
      projectAcpRegistryAgents(
        await loadRegistry(forceRefresh === true),
        currentAcpPlatform(),
        packageManagerAvailability(),
      ),
  );
  ctx.ipcMain.handle(
    CH.agentRegistryResolve,
    async (_event, id: string): Promise<AcpAgentConfig> => {
      if (!nonEmptyString(id)) throw new Error("A registry agent id is required.");
      const registry = await loadRegistry();
      const agent = registry.agents.find((candidate) => candidate.id === id);
      if (!agent) throw new Error(`Unknown ACP registry agent: ${id}`);
      return resolveAcpRegistryAgent(agent, {
        installBinary: installShared,
        packageManagers: packageManagerAvailability(),
      });
    },
  );

  return () => {
    ctx.ipcMain.removeHandler(CH.agentRegistryList);
    ctx.ipcMain.removeHandler(CH.agentRegistryResolve);
  };
}
