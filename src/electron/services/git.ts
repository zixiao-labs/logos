import { simpleGit, type SimpleGit } from "simple-git";
import { CH } from "../../shared/channels";
import type {
  GitBranch,
  GitFileChange,
  GitLogEntry,
  GitStatus,
} from "../../shared/types";
import type { ServiceContext } from "./context";

const cache = new Map<string, SimpleGit>();

function git(root: string): SimpleGit {
  let g = cache.get(root);
  if (!g) {
    g = simpleGit({ baseDir: root, maxConcurrentProcesses: 4 });
    cache.set(root, g);
  }
  return g;
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

export function registerGitService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;

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

  ipcMain.handle(CH.gitCreateBranch, (_e, root: string, name: string) =>
    git(root).checkoutLocalBranch(name).then(() => undefined),
  );

  ipcMain.handle(
    CH.gitDiff,
    (_e, root: string, file: string, staged: boolean) =>
      staged
        ? git(root).diff(["--staged", "--", file])
        : git(root).diff(["--", file]),
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

  return () => cache.clear();
}
