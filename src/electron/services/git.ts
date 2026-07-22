import simpleGit, { type SimpleGit } from "simple-git";
import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import { CH } from "../../shared/channels";
import type {
  GitBlameLine,
  GitBranch,
  GitCommitDetails,
  GitCommitFile,
  GitFileChange,
  GitFileDiff,
  GitGraphEntry,
  GitLogEntry,
  GitStatus,
} from "../../shared/types";
import type { ServiceContext } from "./context";

const cache = new Map<string, SimpleGit>();
const repositoryRootCache = new Map<string, Promise<string>>();
const GIT_GRAPH_SEPARATOR = "\u001f";
const GIT_GRAPH_RECORD_SEPARATOR = "\u001e";
const NO_COMMIT_ERROR = /does not have any commits yet|bad default revision ['"]?HEAD['"]?/i;
const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;
const WATCH_IGNORED = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "release",
  ".DS_Store",
]);

/** Mirrors Git Graph's repository watcher filter without refreshing on Git internals noise. */
export function shouldRefreshGit(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return false;
  if (normalized.split("/").some(segment => WATCH_IGNORED.has(segment))) return false;
  if (!normalized.startsWith(".git/")) return normalized !== ".git";
  return /^(?:\.git\/(?:config|index|HEAD|packed-refs|refs\/(?:stash|heads\/.*|remotes\/.*|tags\/.*)))$/.test(
    normalized,
  );
}

export function parseGitGraph(output: string): GitGraphEntry[] {
  return output
    .split(GIT_GRAPH_RECORD_SEPARATOR)
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [hash = "", parents = "", refs = "", message = "", author = "", date = ""] =
        record.split(GIT_GRAPH_SEPARATOR);
      return {
        hash,
        shortHash: hash.slice(0, 7),
        parents: parents.split(" ").filter(Boolean),
        refs: refs
          .split(",")
          .map(ref => ref.trim())
          .filter(Boolean),
        message,
        author,
        date,
      };
    });
}

export function parseGitCommitFiles(output: string): GitCommitFile[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) return [];
      const binary = match[1] === "-" || match[2] === "-";
      return [{
        path: match[3],
        additions: binary ? null : Number(match[1]),
        deletions: binary ? null : Number(match[2]),
        binary,
      }];
    });
}

function assertCommitHash(hash: string): void {
  if (!COMMIT_HASH.test(hash)) throw new Error("Invalid commit hash");
}

function git(root: string): SimpleGit {
  let g = cache.get(root);
  if (!g) {
    g = simpleGit({ baseDir: root, maxConcurrentProcesses: 4 });
    cache.set(root, g);
  }
  return g;
}

function repositoryRoot(root: string, g: SimpleGit): Promise<string> {
  let pending = repositoryRootCache.get(root);
  if (!pending) {
    pending = g
      .revparse(["--show-toplevel"])
      .then((value) => fs.realpath(path.resolve(value.trim())));
    repositoryRootCache.set(root, pending);
  }
  return pending.catch((error) => {
    if (repositoryRootCache.get(root) === pending) {
      repositoryRootCache.delete(root);
    }
    throw error;
  });
}

async function status(root: string): Promise<GitStatus> {
  const g = git(root);
  const isRepo = await g.checkIsRepo().catch(() => false);
  if (!isRepo) {
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      clean: true,
    };
  }
  const s = await g.status();
  const changes: GitFileChange[] = s.files.map((f) => {
    const index = f.index === "?" ? " " : f.index || " ";
    const working = f.working_dir || " ";
    return {
      path: f.path,
      ...(f.from ? { originalPath: f.from } : {}),
      index,
      working,
      staged: index !== " " && f.index !== "?",
    };
  });
  return {
    isRepo: true,
    branch: s.current || null,
    ahead: s.ahead,
    behind: s.behind,
    changes,
    clean: s.isClean(),
  };
}

export function parseGitBlamePorcelain(
  output: string,
  repositoryPath: string,
): GitBlameLine | null {
  const lines = output.split(/\r?\n/);
  const header = /^(\^?[0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(
    lines[0] ?? "",
  );
  if (!header) return null;

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.startsWith("\t")) break;
    const separator = line.indexOf(" ");
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  const author = fields.get("author");
  const authorTime = Number(fields.get("author-time"));
  if (!author || !Number.isFinite(authorTime)) return null;

  const hash = header[1].replace(/^\^/, "");
  const uncommitted = /^0+$/.test(hash);
  return {
    hash,
    shortHash: uncommitted ? "" : hash.slice(0, 7),
    message: fields.get("summary") ?? "",
    author,
    authorEmail: uncommitted
      ? ""
      : (fields.get("author-mail") ?? "").replace(/^<|>$/g, ""),
    date: new Date(authorTime * 1000).toISOString(),
    path: repositoryPath,
    originalLine: Number(header[2]),
    finalLine: Number(header[3]),
    uncommitted,
  };
}

export function registerGitService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const watchers = new Map<string, FSWatcher[]>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const scheduleRefresh = (root: string) => {
    const pending = refreshTimers.get(root);
    if (pending) clearTimeout(pending);
    refreshTimers.set(
      root,
      setTimeout(() => {
        refreshTimers.delete(root);
        ctx.send(CH.gitChanged, root);
      }, 300),
    );
  };

  const addWatcher = (
    root: string,
    target: string,
    toRepositoryPath: (filename: string) => string,
  ): FSWatcher | null => {
    try {
      const watcher = fsWatch(target, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (shouldRefreshGit(toRepositoryPath(filename.toString()))) scheduleRefresh(root);
      });
      watcher.on("error", () => watcher.close());
      return watcher;
    } catch {
      return null;
    }
  };

  const stopWatching = (root: string) => {
    for (const watcher of watchers.get(root) ?? []) watcher.close();
    watchers.delete(root);
    const timer = refreshTimers.get(root);
    if (timer) clearTimeout(timer);
    refreshTimers.delete(root);
  };

  const startWatching = async (root: string) => {
    if (watchers.has(root)) return;
    const active: FSWatcher[] = [];
    watchers.set(root, active);
    const rootWatcher = addWatcher(root, root, filename => filename);
    if (rootWatcher) active.push(rootWatcher);
    const gitDir = await git(root)
      .revparse(["--git-dir"])
      .then(value => path.resolve(root, value.trim()))
      .catch(() => null);
    if (gitDir && !gitDir.startsWith(`${root}${path.sep}`)) {
      const gitWatcher = addWatcher(root, gitDir, filename => `.git/${filename}`);
      if (gitWatcher) active.push(gitWatcher);
    }
  };

  ipcMain.handle(CH.gitStatus, (_e, root: string) => status(root));

  ipcMain.handle(CH.gitStage, (_e, root: string, paths: string[]) =>
    git(root).add(paths),
  );

  ipcMain.handle(CH.gitUnstage, (_e, root: string, paths: string[]) =>
    git(root)
      .reset(["HEAD", "--", ...paths])
      .then(() => undefined)
      .catch(() => git(root).reset(["--", ...paths]).then(() => undefined)),
  );

  ipcMain.handle(CH.gitDiscard, async (_e, root: string, paths: string[]) => {
    await git(root)
      .checkout(["--", ...paths])
      .catch(() => undefined);
  });

  ipcMain.handle(CH.gitCommit, (_e, root: string, message: string) =>
    git(root)
      .commit(message)
      .then(() => undefined),
  );

  // Amend the last commit. With a message it rewrites the subject; without one it
  // reuses the existing message (`--no-edit`) — mirrors GitLens' amend flow.
  ipcMain.handle(
    CH.gitCommitAmend,
    (_e, root: string, message: string) =>
      git(root)
        .raw(
          message && message.trim()
            ? ["commit", "--amend", "-m", message]
            : ["commit", "--amend", "--no-edit"],
        )
        .then(() => undefined),
  );

  // The current HEAD commit (null for an empty repo or non-repo), shown at the
  // top of the panel so the last commit is always visible.
  ipcMain.handle(
    CH.gitHead,
    async (_e, root: string): Promise<GitLogEntry | null> => {
      const g = git(root);
      const isRepo = await g.checkIsRepo().catch(() => false);
      if (!isRepo) return null;
      try {
        const log = await g.log({ maxCount: 1 });
        const c = log.latest;
        if (!c) return null;
        return {
          hash: c.hash,
          shortHash: c.hash.slice(0, 7),
          message: c.message,
          author: c.author_name,
          date: c.date,
        };
      } catch {
        return null; // no commits yet
      }
    },
  );

  // Undo the last commit but keep the changes staged (GitLens "Undo Commit" =
  // soft reset; see src/git/actions/repository.ts using `reset --soft`).
  ipcMain.handle(CH.gitUndoLastCommit, (_e, root: string) =>
    git(root)
      .reset(["--soft", "HEAD~1"])
      .then(() => undefined),
  );

  ipcMain.handle(CH.gitBranches, async (_e, root: string): Promise<GitBranch[]> => {
    const b = await git(root).branchLocal();
    return b.all.map((name) => ({ name, current: name === b.current }));
  });

  ipcMain.handle(CH.gitCheckout, (_e, root: string, branch: string) =>
    git(root).checkout(branch).then(() => undefined),
  );

  ipcMain.handle(
    CH.gitCreateBranch,
    async (_e, root: string, name: string, startPoint?: string) => {
      const g = git(root);
      await g.raw(["check-ref-format", "--branch", name]);
      if (startPoint) {
        assertCommitHash(startPoint);
        await g.raw(["checkout", "-b", name, startPoint]);
      } else {
        await g.checkoutLocalBranch(name);
      }
    },
  );

  ipcMain.handle(
    CH.gitDiff,
    (_e, root: string, file: string, staged: boolean) =>
      staged
        ? git(root).diff(["--staged", "--", file])
        : git(root).diff(["--", file]),
  );

  ipcMain.handle(
    CH.gitFileDiff,
    async (
      _e,
      root: string,
      file: string,
      staged: boolean,
    ): Promise<GitFileDiff> => {
      const g = git(root);
      const repositoryPath = file.replaceAll("\\", "/");
      const statusEntry = (await g.status()).files.find(
        (entry) => entry.path === file,
      );
      const originalRepositoryPath = (statusEntry?.from ?? file).replaceAll(
        "\\",
        "/",
      );
      const show = (revision: string) =>
        g.raw(["show", `${revision}:${repositoryPath}`]).catch(() => "");
      const showOriginal = (revision: string) =>
        g.raw(["show", `${revision}:${originalRepositoryPath}`]).catch(() => "");
      const original = staged
        ? await showOriginal("HEAD")
        : await g
            .raw(["show", `:${repositoryPath}`])
            .catch(() => showOriginal("HEAD"));
      const modified = staged
        ? await g.raw(["show", `:${repositoryPath}`]).catch(() => "")
        : await fs.readFile(path.join(root, file), "utf8").catch(() => "");
      return { path: file, staged, original, modified };
    },
  );

  ipcMain.handle(
    CH.gitLog,
    async (_e, root: string, limit = 50): Promise<GitLogEntry[]> => {
      const log = await git(root).log({ maxCount: limit });
      return log.all.map((c) => ({
        hash: c.hash,
        shortHash: c.hash.slice(0, 7),
        message: c.message,
        author: c.author_name,
        date: c.date,
      }));
    },
  );

  ipcMain.handle(
    CH.gitGraph,
    async (_e, root: string, limit = 200): Promise<GitGraphEntry[]> => {
      let output: string;
      try {
        output = await git(root).raw([
          "log",
          "--all",
          `--max-count=${limit}`,
          "--date=iso-strict",
          `--pretty=format:%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%aI%x1e`,
        ]);
      } catch (error) {
        if (NO_COMMIT_ERROR.test(error instanceof Error ? error.message : String(error))) {
          return [];
        }
        throw error;
      }
      return parseGitGraph(output);
    },
  );

  ipcMain.handle(
    CH.gitCommitDetails,
    async (_e, root: string, hash: string): Promise<GitCommitDetails> => {
      assertCommitHash(hash);
      const g = git(root);
      const [metadata, fileOutput] = await Promise.all([
        g.raw([
          "show",
          "--no-patch",
          "--date=iso-strict",
          "--format=%H%x00%P%x00%D%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%b",
          hash,
        ]),
        g.raw([
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--numstat",
          "-r",
          "-M",
          hash,
        ]),
      ]);
      const [
        commitHash = "",
        parents = "",
        refs = "",
        message = "",
        author = "",
        authorEmail = "",
        date = "",
        committer = "",
        committerEmail = "",
        committedDate = "",
        body = "",
      ] = metadata.trimEnd().split("\0");
      return {
        hash: commitHash,
        shortHash: commitHash.slice(0, 7),
        parents: parents.split(" ").filter(Boolean),
        refs: refs.split(",").map(ref => ref.trim()).filter(Boolean),
        message,
        author,
        authorEmail,
        date,
        committer,
        committerEmail,
        committedDate,
        body: body.trim(),
        files: parseGitCommitFiles(fileOutput),
      };
    },
  );

  ipcMain.handle(CH.gitCherryPick, async (_e, root: string, hash: string) => {
    assertCommitHash(hash);
    await git(root).raw(["cherry-pick", hash]);
  });

  ipcMain.handle(CH.gitRevert, async (_e, root: string, hash: string) => {
    assertCommitHash(hash);
    await git(root).raw(["revert", "--no-edit", hash]);
  });

  ipcMain.handle(
    CH.gitBlame,
    async (
      _e,
      root: string,
      file: string,
      line: number,
    ): Promise<GitBlameLine | null> => {
      if (
        typeof root !== "string" ||
        typeof file !== "string" ||
        !Number.isInteger(line) ||
        line < 1 ||
        !path.isAbsolute(file)
      ) return null;
      const g = git(root);
      try {
        const rootPath = await repositoryRoot(root, g);
        // Keep the final path segment intact so a tracked symlink is blamed as
        // the repository entry rather than as its potentially external target.
        const resolvedFile = path.resolve(file);
        const canonicalFile = path.join(
          await fs.realpath(path.dirname(resolvedFile)),
          path.basename(resolvedFile),
        );
        const relativePath = path.relative(rootPath, canonicalFile);
        if (
          !relativePath ||
          relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)
        ) return null;
        const repositoryPath = relativePath.split(path.sep).join("/");
        const output = await g.raw([
          "blame",
          "--line-porcelain",
          "-L",
          `${line},${line}`,
          "--",
          repositoryPath,
        ]);
        return parseGitBlamePorcelain(output, repositoryPath);
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(CH.gitInit, (_e, root: string) =>
    git(root).init().then(() => undefined),
  );

  ipcMain.handle(CH.gitFetch, (_e, root: string) =>
    git(root)
      .fetch()
      .then(() => "Fetched")
      .catch((err: Error) => `Fetch failed: ${err.message}`),
  );

  ipcMain.handle(CH.gitPull, (_e, root: string) =>
    git(root)
      .pull()
      .then((r) => `${r.summary.changes} changes, ${r.summary.insertions}+ ${r.summary.deletions}-`)
      .catch((err: Error) => `Pull failed: ${err.message}`),
  );

  ipcMain.handle(CH.gitPush, async (_e, root: string) => {
    const g = git(root);
    try {
      await g.push();
      return "Pushed";
    } catch (err) {
      // Most common failure is a branch with no upstream. Publish it (set the
      // upstream to origin) the way GitLens' "Publish Branch" does, then report.
      try {
        const branch = (await g.branchLocal()).current;
        // Prefer "origin", but fall back to whatever remote the repo actually
        // has — a fresh branch with no upstream may live under a differently
        // named remote, and hardcoding "origin" would fail those repos.
        const remotes = await g.getRemotes();
        const remote =
          remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
        if (!remote) return "Push failed: no remote configured";
        await g.push(["--set-upstream", remote, branch]);
        return `Published ${branch} to ${remote}`;
      } catch {
        return `Push failed: ${(err as Error).message}`;
      }
    }
  });

  // Sync = pull (rebase) then push, like the VS Code / GitLens sync action.
  ipcMain.handle(CH.gitSync, async (_e, root: string) => {
    const g = git(root);
    try {
      await g.pull(undefined, undefined, { "--rebase": "true" });
    } catch (err) {
      return `Sync failed (pull): ${(err as Error).message}`;
    }
    try {
      await g.push();
      return "Synced";
    } catch (err) {
      return `Sync failed (push): ${(err as Error).message}`;
    }
  });

  ipcMain.handle(CH.gitWatch, async (_e, roots: string[]) => {
    const desired = new Set(roots);
    for (const root of watchers.keys()) {
      if (!desired.has(root)) stopWatching(root);
    }
    await Promise.all(roots.map(startWatching));
  });

  return () => {
    for (const root of [...watchers.keys()]) stopWatching(root);
    cache.clear();
    repositoryRootCache.clear();
  };
}
