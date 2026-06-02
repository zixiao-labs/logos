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

  ipcMain.handle(CH.gitPull, (_e, root: string) =>
    git(root)
      .pull()
      .then((r) => `${r.summary.changes} changes, ${r.summary.insertions}+ ${r.summary.deletions}-`)
      .catch((err: Error) => `Pull failed: ${err.message}`),
  );

  ipcMain.handle(CH.gitPush, (_e, root: string) =>
    git(root)
      .push()
      .then(() => "Pushed")
      .catch((err: Error) => `Push failed: ${err.message}`),
  );

  return () => cache.clear();
}
