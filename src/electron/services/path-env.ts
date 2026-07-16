import os from "node:os";
import path from "node:path";

const SYSTEM_PATH_FALLBACKS = [
  path.join(os.homedir(), ".opencode", "bin"),
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

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
    ...(process.platform === "win32" ? [] : SYSTEM_PATH_FALLBACKS),
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
