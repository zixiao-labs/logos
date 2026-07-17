import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function compareNodeVersions(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function resolveNvmVersion(
  reference: string,
  versions: string[],
  nvmDir: string,
  seen = new Set<string>(),
): string | undefined {
  const value = reference.trim();
  if (!value || seen.has(value)) return undefined;
  seen.add(value);

  const normalized = value.startsWith("v") ? value : `v${value}`;
  const exact = versions.find((version) => version === normalized);
  if (exact) return exact;
  if (/^v?\d+(?:\.\d+)?$/.test(value)) {
    const prefix = `${normalized}.`;
    const matching = versions.find((version) => version.startsWith(prefix));
    if (matching) return matching;
  }
  if (value === "node" || value === "stable" || value === "*") {
    return versions[0];
  }

  const aliasRoot = path.resolve(nvmDir, "alias");
  const aliasPath = path.resolve(aliasRoot, value);
  if (aliasPath !== aliasRoot && !aliasPath.startsWith(`${aliasRoot}${path.sep}`)) {
    return undefined;
  }
  try {
    return resolveNvmVersion(
      readFileSync(aliasPath, "utf8"),
      versions,
      nvmDir,
      seen,
    );
  } catch {
    return undefined;
  }
}

function nvmBinEntries(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") return [];
  const home = env.HOME || os.homedir();
  const nvmDir = env.NVM_DIR || path.join(home, ".nvm");
  const versionsRoot = path.join(nvmDir, "versions", "node");
  let versions: string[] = [];
  try {
    versions = readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v\d+(?:\.\d+){2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareNodeVersions);
  } catch {
    // NVM is optional and its directory may not exist in production.
  }

  let preferred: string | undefined;
  try {
    preferred = resolveNvmVersion(
      readFileSync(path.join(nvmDir, "alias", "default"), "utf8"),
      versions,
      nvmDir,
    );
  } catch {
    // Fall back to the newest installed version.
  }
  const orderedVersions = preferred
    ? [preferred, ...versions.filter((version) => version !== preferred)]
    : versions;
  return [
    ...(env.NVM_BIN ? [env.NVM_BIN] : []),
    ...orderedVersions
      .map((version) => path.join(versionsRoot, version, "bin"))
      .filter((bin) => existsSync(path.join(bin, "node"))),
  ];
}

function systemPathFallbacks(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, ".opencode", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

export function augmentPath(env: NodeJS.ProcessEnv): void {
  const separator = process.platform === "win32" ? ";" : ":";
  let existingPath = "";
  let outputKey = "PATH";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== "path") continue;
    existingPath = env[key] ?? existingPath;
    if (process.platform === "win32") outputKey = key;
    delete env[key];
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const entries = [
    ...(resourcesPath ? [path.join(resourcesPath, "bin")] : []),
    ...existingPath.split(separator),
    ...nvmBinEntries(env),
    ...(process.platform === "win32" ? [] : systemPathFallbacks(env)),
  ].filter(Boolean);
  const seen = new Set<string>();
  env[outputKey] = entries
    .filter((entry) => {
      const key = process.platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(separator);
}
