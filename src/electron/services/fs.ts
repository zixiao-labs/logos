import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CH } from "../../shared/channels";
import type {
  ConditionalWriteResult,
  DirListing,
  FileEntry,
  FileSnapshot,
  FileStat,
  TextSearchMatch,
  TextSearchOptions,
} from "../../shared/types";
import type { ServiceContext } from "./context";

/** Directories we never want to descend into or list eagerly. */
const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);
const WATCH_IGNORED = new Set([".git", "node_modules", ".DS_Store"]);
const SEARCH_IGNORED = new Set([
  ...IGNORED,
  ".nasti",
  ".next",
  ".cache",
  "build",
  "coverage",
  "dist",
  "out",
  "release",
  "target",
]);
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 20_000;
const SEARCH_CONCURRENCY = 16;

function fileRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { exists: true, content, revision: fileRevision(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, revision: "missing" };
    }
    throw error;
  }
}

async function conditionalWriteTarget(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(filePath);
        return path.resolve(path.dirname(filePath), link);
      }
    } catch {
      // The target does not exist yet.
    }
    return path.resolve(filePath);
  }
}

async function conditionalWriteKey(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `inode:${stat.dev}:${stat.ino}`;
  } catch {
    return `path:${await conditionalWriteTarget(filePath)}`;
  }
}

async function readDir(dirPath: string): Promise<DirListing> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    if (IGNORED.has(d.name)) continue;
    const full = path.join(dirPath, d.name);
    const isDir = d.isDirectory();
    entries.push({
      name: d.name,
      path: full,
      type: isDir ? "directory" : "file",
      hasChildren: isDir ? undefined : false,
    });
  }
  // Directories first, then alphabetical (case-insensitive).
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return { path: dirPath, entries };
}

async function collectSearchFiles(root: string): Promise<string[]> {
  const directories = [root];
  const files: string[] = [];
  while (directories.length && files.length < MAX_SEARCH_FILES) {
    const directory = directories.shift();
    if (!directory) break;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SEARCH_IGNORED.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(full);
      else if (entry.isFile()) files.push(full);
      if (files.length >= MAX_SEARCH_FILES) break;
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function searchFile(
  filePath: string,
  query: string,
  caseSensitive: boolean,
  maxMatches: number,
): Promise<TextSearchMatch[]> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return [];
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) return [];
    const content = buffer.toString("utf8");
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: TextSearchMatch[] = [];
    for (const [index, text] of content.split(/\r?\n/).entries()) {
      const haystack = caseSensitive ? text : text.toLocaleLowerCase();
      let offset = 0;
      while (offset <= haystack.length - needle.length) {
        const found = haystack.indexOf(needle, offset);
        if (found === -1) break;
        matches.push({
          path: filePath,
          line: index + 1,
          column: found + 1,
          endColumn: found + query.length + 1,
          text,
        });
        if (matches.length >= maxMatches) return matches;
        offset = found + Math.max(needle.length, 1);
      }
    }
    return matches;
  } catch {
    return [];
  }
}

async function searchText(
  root: string,
  query: string,
  options: TextSearchOptions = {},
): Promise<TextSearchMatch[]> {
  if (!query) return [];
  const files = await collectSearchFiles(root);
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 1000, 5000));
  const results: TextSearchMatch[] = [];
  for (let index = 0; index < files.length; index += SEARCH_CONCURRENCY) {
    const batch = await Promise.all(
      files
        .slice(index, index + SEARCH_CONCURRENCY)
        .map((file) =>
          searchFile(file, query, Boolean(options.caseSensitive), maxResults),
        ),
    );
    for (const matches of batch) {
      results.push(...matches.slice(0, maxResults - results.length));
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

export function registerFsService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const workspaceAccess = ctx.workspaceAccess;
  if (!workspaceAccess) throw new Error("Workspace access controller is required.");
  const watchers = new Map<string, { watcher: FSWatcher; references: number }>();
  const conditionalWrites = new Map<string, Promise<ConditionalWriteResult>>();
  // Coalesce rapid-fire fs events so we don't flood the renderer.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  ipcMain.handle(CH.fsReadDir, async (_e, p: string) =>
    readDir(await workspaceAccess.assertPath(p)),
  );

  ipcMain.handle(CH.fsReadFile, async (_e, p: string) =>
    fs.readFile(await workspaceAccess.assertPath(p), "utf8"),
  );

  ipcMain.handle(CH.fsReadFileSnapshot, async (_e, p: string) =>
    readFileSnapshot(await workspaceAccess.assertPath(p)),
  );

  ipcMain.handle(
    CH.fsSearchText,
    async (_e, root: string, query: string, options?: TextSearchOptions) =>
      searchText(await workspaceAccess.assertPath(root), query, options),
  );

  ipcMain.handle(CH.fsWriteFile, async (_e, p: string, content: string) => {
    const target = await workspaceAccess.assertPath(p, "write");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  });

  ipcMain.handle(
    CH.fsWriteFileConditional,
    async (
      _e,
      p: string,
      content: string,
      expectedRevision: string,
    ): Promise<ConditionalWriteResult> => {
      p = await workspaceAccess.assertPath(p, "write");
      const queueKey = await conditionalWriteKey(p);
      const previous =
        conditionalWrites.get(queueKey)?.catch(() => undefined) ?? Promise.resolve();
      const operation = previous.then(async () => {
        const current = await readFileSnapshot(p);
        if (current.revision !== expectedRevision) {
          return { status: "conflict", current } as const;
        }
        const target = await workspaceAccess.assertPath(
          await conditionalWriteTarget(p),
          "write",
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temp, content, "utf8");
          const latest = await readFileSnapshot(p);
          const latestTarget = await conditionalWriteTarget(p);
          if (
            latest.revision !== expectedRevision ||
            latestTarget !== target
          ) {
            return { status: "conflict", current: latest } as const;
          }
          if (latest.exists) {
            const mode = (await fs.stat(target)).mode & 0o7777;
            await fs.chmod(temp, mode);
          }
          await workspaceAccess.assertPath(target, "write");
          await fs.rename(temp, target);
          return {
            status: "written-optimistically",
            revision: fileRevision(content),
          } as const;
        } finally {
          await fs.rm(temp, { force: true }).catch(() => undefined);
        }
      });
      conditionalWrites.set(queueKey, operation);
      void operation.finally(() => {
        if (conditionalWrites.get(queueKey) === operation) {
          conditionalWrites.delete(queueKey);
        }
      }).catch(() => undefined);
      return operation;
    },
  );

  ipcMain.handle(CH.fsStat, async (_e, p: string): Promise<FileStat> => {
    const target = await workspaceAccess.assertPath(p);
    const s = await fs.stat(target);
    return {
      path: target,
      type: s.isDirectory() ? "directory" : "file",
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  });

  ipcMain.handle(CH.fsCreateFile, async (_e, p: string, content = "") => {
    const target = await workspaceAccess.assertPath(p, "write");
    await fs.mkdir(path.dirname(target), { recursive: true });
    // wx => fail if it already exists.
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
  });

  ipcMain.handle(CH.fsCreateDir, async (_e, p: string) => {
    await fs.mkdir(await workspaceAccess.assertPath(p, "write"), {
      recursive: true,
    });
  });

  ipcMain.handle(CH.fsRename, async (_e, from: string, to: string) =>
    fs.rename(
      await workspaceAccess.assertPath(from, "write"),
      await workspaceAccess.assertPath(to, "write"),
    ),
  );

  ipcMain.handle(CH.fsDelete, async (_e, p: string) =>
    fs.rm(await workspaceAccess.assertPath(p, "write"), {
      recursive: true,
      force: true,
    }),
  );

  ipcMain.handle(CH.fsExists, async (_e, p: string) =>
    fs
      .access(await workspaceAccess.assertPath(p))
      .then(() => true)
      .catch(() => false),
  );

  ipcMain.handle(CH.fsWatch, async (_e, root: string) => {
    root = await workspaceAccess.assertPath(root);
    const existing = watchers.get(root);
    if (existing) {
      existing.references++;
      return;
    }
    try {
      const w = fsWatch(
        root,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;
          const name = filename.toString();
          if ([...WATCH_IGNORED].some((ig) => name.split(path.sep).includes(ig)))
            return;
          const full = path.join(root, name);
          const key = `${eventType}:${full}`;
          const existing = pending.get(key);
          if (existing) clearTimeout(existing);
          pending.set(
            key,
            setTimeout(async () => {
              pending.delete(key);
              try {
                await workspaceAccess.assertPath(full);
              } catch {
                return;
              }
              const exists = await fs
                .access(full)
                .then(() => true)
                .catch(() => false);
              ctx.send(CH.fsWatchEvent, {
                type: !exists
                  ? "delete"
                  : eventType === "change"
                    ? "change"
                    : "create",
                path: full,
              });
            }, 80),
          );
        },
      );
      w.on("error", () => {
        const entry = watchers.get(root);
        if (entry?.watcher === w) watchers.delete(root);
        w.close();
      });
      watchers.set(root, { watcher: w, references: 1 });
    } catch {
      // Recursive watch is unsupported on some platforms; ignore silently.
    }
  });

  ipcMain.handle(CH.fsUnwatch, async (_e, root: string) => {
    root = await workspaceAccess.canonicalize(root);
    const entry = watchers.get(root);
    if (!entry) return;
    entry.references--;
    if (entry.references > 0) return;
    entry.watcher.close();
    watchers.delete(root);
  });

  return () => {
    for (const entry of watchers.values()) entry.watcher.close();
    watchers.clear();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };
}
