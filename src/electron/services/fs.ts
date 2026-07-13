import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import { CH } from "../../shared/channels";
import type { DirListing, FileEntry, FileStat } from "../../shared/types";
import type { ServiceContext } from "./context";

/** Directories we never want to descend into or list eagerly. */
const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);
const WATCH_IGNORED = new Set([".git", "node_modules", ".DS_Store"]);

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

export function registerFsService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const watchers = new Map<string, { watcher: FSWatcher; references: number }>();
  // Coalesce rapid-fire fs events so we don't flood the renderer.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  ipcMain.handle(CH.fsReadDir, (_e, p: string) => readDir(p));

  ipcMain.handle(CH.fsReadFile, (_e, p: string) => fs.readFile(p, "utf8"));

  ipcMain.handle(CH.fsWriteFile, async (_e, p: string, content: string) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  });

  ipcMain.handle(CH.fsStat, async (_e, p: string): Promise<FileStat> => {
    const s = await fs.stat(p);
    return {
      path: p,
      type: s.isDirectory() ? "directory" : "file",
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  });

  ipcMain.handle(CH.fsCreateFile, async (_e, p: string, content = "") => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    // wx => fail if it already exists.
    await fs.writeFile(p, content, { encoding: "utf8", flag: "wx" });
  });

  ipcMain.handle(CH.fsCreateDir, (_e, p: string) =>
    fs.mkdir(p, { recursive: true }).then(() => undefined),
  );

  ipcMain.handle(CH.fsRename, (_e, from: string, to: string) =>
    fs.rename(from, to),
  );

  ipcMain.handle(CH.fsDelete, (_e, p: string) =>
    fs.rm(p, { recursive: true, force: true }),
  );

  ipcMain.handle(CH.fsExists, (_e, p: string) =>
    fs
      .access(p)
      .then(() => true)
      .catch(() => false),
  );

  ipcMain.handle(CH.fsWatch, (_e, root: string) => {
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
            setTimeout(() => {
              pending.delete(key);
              ctx.send(CH.fsWatchEvent, {
                type: eventType === "rename" ? "rename" : "change",
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

  ipcMain.handle(CH.fsUnwatch, (_e, root: string) => {
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
