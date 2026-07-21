import path from "node:path";
import type { WorkspaceAccessController } from "./workspace-access";

const DEBUG_PATH_KEYS = ["program", "file", "script"] as const;

export async function authorizeDebugConfigurationPaths(
  workspaceAccess: WorkspaceAccessController,
  configuration: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const normalized = { ...configuration };
  const hasRelativePath = DEBUG_PATH_KEYS.some((key) => {
    const candidate = configuration[key];
    return typeof candidate === "string" && !path.isAbsolute(candidate);
  });
  const configuredCwd = configuration.cwd;
  let controlledCwd: string | undefined;

  if (typeof configuredCwd === "string" || hasRelativePath) {
    const root = workspaceAccess.currentRoot();
    const cwdCandidate =
      typeof configuredCwd === "string" && path.isAbsolute(configuredCwd)
        ? configuredCwd
        : root
          ? path.resolve(root, typeof configuredCwd === "string" ? configuredCwd : ".")
          : null;
    if (!cwdCandidate) {
      throw new Error("A workspace must be open to resolve relative debug paths.");
    }
    controlledCwd = await workspaceAccess.assertPath(cwdCandidate);
    normalized.cwd = controlledCwd;
  }

  for (const key of DEBUG_PATH_KEYS) {
    const candidate = configuration[key];
    if (typeof candidate !== "string") continue;
    normalized[key] = await workspaceAccess.assertPath(
      path.isAbsolute(candidate)
        ? candidate
        : path.resolve(controlledCwd!, candidate),
    );
  }
  return normalized;
}
