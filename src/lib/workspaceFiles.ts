/** Recursively lists workspace files (bounded), skipping heavy directories. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".cache",
  "target",
]);

const cache = new Map<string, { files: string[]; at: number }>();

async function walk(dir: string, acc: string[], limit: number): Promise<void> {
  if (acc.length >= limit) return;
  let listing;
  try {
    listing = await window.logos.fs.readDir(dir);
  } catch {
    return;
  }
  for (const entry of listing.entries) {
    if (acc.length >= limit) return;
    if (entry.type === "directory") {
      if (SKIP.has(entry.name)) continue;
      await walk(entry.path, acc, limit);
    } else {
      acc.push(entry.path);
    }
  }
}

export async function listWorkspaceFiles(
  root: string,
  limit = 8000,
  maxAgeMs = 10000,
): Promise<string[]> {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.files;
  const files: string[] = [];
  await walk(root, files, limit);
  cache.set(root, { files, at: Date.now() });
  return files;
}

export function invalidateWorkspaceFiles(root?: string) {
  if (root) cache.delete(root);
  else cache.clear();
}
