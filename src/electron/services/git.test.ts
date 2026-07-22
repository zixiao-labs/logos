import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@lightning-js/lightning";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CH } from "../../shared/channels";
import type {
  GitBlameLine,
  GitCommitDetails,
  GitFileDiff,
  GitGraphEntry,
  GitLogEntry,
  GitStatus,
} from "../../shared/types";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import {
  parseGitBlamePorcelain,
  parseGitCommitFiles,
  parseGitGraph,
  registerGitService,
  shouldRefreshGit,
} from "./git";

const exec = promisify(execFile);

describe("git service", () => {
  let root: string;
  let cleanup: () => void;
  let service: ReturnType<typeof createIpcHarness>;
  let gitChanged: ((root: string) => void) | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "logos-git-"));
    service = createIpcHarness();
    cleanup = registerGitService({
      ipcMain: service.ipcMain,
      userDataDir: root,
      getWindow: () => null,
      isTrustedSender: () => true,
      send: (channel, changedRoot) => {
        if (channel === CH.gitChanged) gitChanged?.(String(changedRoot));
      },
    } satisfies ServiceContext);
  });

  afterEach(async () => {
    cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports a directory outside a repository", async () => {
    expect(await service.invoke<GitStatus>(CH.gitStatus, root)).toEqual({
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      clean: true,
    });
    expect(
      await service.invoke(CH.gitBlame, root, path.join(root, "note.txt"), 1),
    ).toBeNull();
  });

  it("parses graph records and filters repository watch events", () => {
    expect(
      parseGitGraph(
        "abcdef123456789\u001fparent1 parent2\u001fHEAD -> main, tag: v1\u001fSubject\u001fAuthor\u001f2026-07-21T00:00:00Z\u001e",
      ),
    ).toEqual([
      {
        hash: "abcdef123456789",
        shortHash: "abcdef1",
        parents: ["parent1", "parent2"],
        refs: ["HEAD -> main", "tag: v1"],
        message: "Subject",
        author: "Author",
        date: "2026-07-21T00:00:00Z",
      },
    ]);
    expect(shouldRefreshGit("src/app.ts")).toBe(true);
    expect(shouldRefreshGit(".git/HEAD")).toBe(true);
    expect(shouldRefreshGit(".git/objects/12/object")).toBe(false);
    expect(shouldRefreshGit("node_modules/pkg/index.js")).toBe(false);
    expect(parseGitCommitFiles("3\t1\tsrc/app.ts\n-\t-\timage.png\n")).toEqual([
      {
        path: "src/app.ts",
        additions: 3,
        deletions: 1,
        binary: false,
      },
      {
        path: "image.png",
        additions: null,
        deletions: null,
        binary: true,
      },
    ]);
  });

  it("returns an empty graph before the first commit and preserves unrelated errors", async () => {
    await expect(service.invoke(CH.gitGraph, root, 10)).rejects.toThrow();
    await service.invoke(CH.gitInit, root);
    await expect(
      service.invoke<GitGraphEntry[]>(CH.gitGraph, root, 10),
    ).resolves.toEqual([]);
  });

  it("pushes a debounced refresh when a watched working-tree file changes", async () => {
    const changed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for the Git watcher")),
        3_000,
      );
      gitChanged = (changedRoot) => {
        clearTimeout(timeout);
        resolve(changedRoot);
      };
    });
    await service.invoke(CH.gitWatch, [root]);
    await fs.writeFile(path.join(root, "watched.txt"), "changed", "utf8");

    await expect(changed).resolves.toBe(root);
  });

  it("returns committed and working-tree blame for one line", async () => {
    await service.invoke(CH.gitInit, root);
    await exec("git", ["-C", root, "config", "user.name", "Logos Tests"]);
    await exec("git", ["-C", root, "config", "user.email", "tests@logos.local"]);
    const file = path.join(root, "note with spaces.txt");
    await fs.writeFile(file, "first\nsecond\n", "utf8");
    await service.invoke(CH.gitStage, root, ["note with spaces.txt"]);
    await service.invoke(CH.gitCommit, root, "Add two lines");

    const committed = await service.invoke<GitBlameLine | null>(
      CH.gitBlame,
      root,
      file,
      1,
    );
    expect(committed).toMatchObject({
      author: "Logos Tests",
      authorEmail: "tests@logos.local",
      message: "Add two lines",
      path: "note with spaces.txt",
      originalLine: 1,
      finalLine: 1,
      uncommitted: false,
    });
    expect(committed?.hash).toHaveLength(40);
    expect(committed?.shortHash).toHaveLength(7);
    expect(Number.isNaN(Date.parse(committed?.date ?? ""))).toBe(false);

    await fs.writeFile(file, "changed\nsecond\n", "utf8");
    expect(
      await service.invoke<GitBlameLine | null>(CH.gitBlame, root, file, 1),
    ).toMatchObject({
      hash: "0000000000000000000000000000000000000000",
      shortHash: "",
      path: "note with spaces.txt",
      finalLine: 1,
      uncommitted: true,
    });
    expect(
      await service.invoke<GitBlameLine | null>(CH.gitBlame, root, file, 2),
    ).toMatchObject({ message: "Add two lines", uncommitted: false });

    const untracked = path.join(root, "untracked.txt");
    await fs.writeFile(untracked, "new\n", "utf8");
    expect(await service.invoke(CH.gitBlame, root, untracked, 1)).toBeNull();
    expect(await service.invoke(CH.gitBlame, root, file, 99)).toBeNull();
    expect(await service.invoke(CH.gitBlame, root, file, 0)).toBeNull();
    expect(await service.invoke(CH.gitBlame, root, file, 1.5)).toBeNull();
    expect(await service.invoke(CH.gitBlame, root, "relative.txt", 1)).toBeNull();
    expect(
      await service.invoke(CH.gitBlame, root, null as unknown as string, 1),
    ).toBeNull();
    expect(
      await service.invoke(CH.gitBlame, null as unknown as string, file, 1),
    ).toBeNull();
    expect(await service.invoke(CH.gitBlame, root, root, 1)).toBeNull();
    expect(
      await service.invoke(CH.gitBlame, root, path.dirname(root), 1),
    ).toBeNull();
    expect(
      await service.invoke(
        CH.gitBlame,
        root,
        path.join(root, "..", "outside.txt"),
        1,
      ),
    ).toBeNull();
  });

  it("parses blame porcelain defensively", () => {
    expect(parseGitBlamePorcelain("", "note.txt")).toBeNull();
    expect(
      parseGitBlamePorcelain(
        `${"0".repeat(40)} 1 1\nauthor Nobody\n\tline`,
        "note.txt",
      ),
    ).toBeNull();
    expect(
      parseGitBlamePorcelain(
        `${"0".repeat(40)} 1 1\nauthor Nobody\nauthor-mail <not.committed.yet>\nauthor-time invalid\n\tline`,
        "note.txt",
      ),
    ).toBeNull();
    expect(
      parseGitBlamePorcelain(
        `^${"a".repeat(40)} 4 7\nauthor Ada\nauthor-time 0\n\tline`,
        "note.txt",
      ),
    ).toEqual({
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      message: "",
      author: "Ada",
      authorEmail: "",
      date: "1970-01-01T00:00:00.000Z",
      path: "note.txt",
      originalLine: 4,
      finalLine: 7,
      uncommitted: false,
    });
  });

  it("normalizes command failures and a removed workspace", async () => {
    expect(await service.invoke<string>(CH.gitFetch, root)).toMatch(
      /^Fetch failed:/,
    );

    await service.invoke(CH.gitInit, root);
    await expect(
      service.invoke(CH.gitDiscard, root, ["missing.txt"]),
    ).resolves.toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });

    expect(await service.invoke<GitStatus>(CH.gitStatus, root)).toEqual({
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      clean: true,
    });
    expect(await service.invoke(CH.gitHead, root)).toBeNull();
  });

  it("tracks the stage, commit, head, log, branches, and working diff", async () => {
    await service.invoke(CH.gitInit, root);
    await exec("git", ["-C", root, "config", "user.name", "Logos Tests"]);
    await exec("git", ["-C", root, "config", "user.email", "tests@logos.local"]);
    expect(await service.invoke(CH.gitHead, root)).toBeNull();
    const file = path.join(root, "note.txt");
    await fs.writeFile(file, "first\n", "utf8");

    let status = await service.invoke<GitStatus>(CH.gitStatus, root);
    expect(status.clean).toBe(false);
    expect(status.changes[0]).toMatchObject({
      path: "note.txt",
      staged: false,
    });

    await service.invoke(CH.gitStage, root, ["note.txt"]);
    status = await service.invoke<GitStatus>(CH.gitStatus, root);
    expect(status.changes[0]?.staged).toBe(true);

    // Unstaging an unborn branch exercises the fallback that does not use HEAD.
    await service.invoke(CH.gitUnstage, root, ["note.txt"]);
    expect(
      (await service.invoke<GitStatus>(CH.gitStatus, root)).changes[0]?.staged,
    ).toBe(false);
    await service.invoke(CH.gitStage, root, ["note.txt"]);
    await service.invoke(CH.gitCommit, root, "Initial commit");
    expect((await service.invoke<GitStatus>(CH.gitStatus, root)).clean).toBe(true);
    let head = await service.invoke<GitLogEntry>(CH.gitHead, root);
    expect(head.message).toBe("Initial commit");
    expect(head.shortHash).toHaveLength(7);
    expect(await service.invoke<GitLogEntry[]>(CH.gitLog, root, 1)).toHaveLength(1);

    await service.invoke(CH.gitCommitAmend, root, "Amended commit");
    head = await service.invoke<GitLogEntry>(CH.gitHead, root);
    expect(head.message).toBe("Amended commit");
    await service.invoke(CH.gitCommitAmend, root, "");

    const originalBranch = (await service.invoke<GitStatus>(CH.gitStatus, root))
      .branch!;
    await service.invoke(CH.gitCreateBranch, root, "feature");
    expect(
      await service.invoke<Array<{ name: string; current: boolean }>>(
        CH.gitBranches,
        root,
      ),
    ).toContainEqual({ name: "feature", current: true });
    await service.invoke(CH.gitCheckout, root, originalBranch);

    await fs.writeFile(file, "second\n", "utf8");
    expect(await service.invoke<string>(CH.gitDiff, root, "note.txt", false)).toContain(
      "+second",
    );
    expect(
      await service.invoke<GitFileDiff>(CH.gitFileDiff, root, "note.txt", false),
    ).toMatchObject({
      original: "first\n",
      modified: "second\n",
      staged: false,
    });
    await service.invoke(CH.gitStage, root, ["note.txt"]);
    expect(await service.invoke<string>(CH.gitDiff, root, "note.txt", true)).toContain(
      "+second",
    );
    expect(
      await service.invoke<GitFileDiff>(CH.gitFileDiff, root, "note.txt", true),
    ).toMatchObject({
      original: "first\n",
      modified: "second\n",
      staged: true,
    });
    await fs.writeFile(file, "third\n", "utf8");
    expect(
      await service.invoke<GitFileDiff>(CH.gitFileDiff, root, "note.txt", false),
    ).toMatchObject({
      original: "second\n",
      modified: "third\n",
    });
    await fs.writeFile(file, "second\n", "utf8");
    await service.invoke(CH.gitCommit, root, "Second commit");
    await service.invoke(CH.gitUndoLastCommit, root);
    expect((await service.invoke<GitLogEntry>(CH.gitHead, root)).message).toBe(
      "Amended commit",
    );
    expect(
      (await service.invoke<GitStatus>(CH.gitStatus, root)).changes[0]?.staged,
    ).toBe(true);

    await service.invoke(CH.gitUnstage, root, ["note.txt"]);
    await service.invoke(CH.gitDiscard, root, ["note.txt"]);
    expect(await fs.readFile(file, "utf8")).toBe("first\n");
    expect((await service.invoke<GitStatus>(CH.gitStatus, root)).clean).toBe(true);

    expect(await service.invoke<string>(CH.gitPush, root)).toBe(
      "Push failed: no remote configured",
    );
    expect(await service.invoke<string>(CH.gitFetch, root)).toMatch(
      /^(Fetched|Fetch failed:)/,
    );
    expect(await service.invoke<string>(CH.gitPull, root)).toMatch(
      /^Pull failed:/,
    );
    expect(await service.invoke<string>(CH.gitSync, root)).toMatch(
      /^Sync failed \(pull\):/,
    );
  });

  it("builds Monaco content pairs for untracked files and staged renames", async () => {
    await service.invoke(CH.gitInit, root);
    await exec("git", ["-C", root, "config", "user.name", "Logos Tests"]);
    await exec("git", ["-C", root, "config", "user.email", "tests@logos.local"]);
    await fs.writeFile(path.join(root, "old.txt"), "renamed content\n", "utf8");
    await service.invoke(CH.gitStage, root, ["old.txt"]);
    await service.invoke(CH.gitCommit, root, "Initial");

    await exec("git", ["-C", root, "mv", "old.txt", "new.txt"]);
    expect(
      await service.invoke<GitFileDiff>(CH.gitFileDiff, root, "new.txt", true),
    ).toMatchObject({
      original: "renamed content\n",
      modified: "renamed content\n",
      staged: true,
    });

    await fs.writeFile(path.join(root, "untracked.txt"), "new file\n", "utf8");
    expect(
      await service.invoke<GitFileDiff>(
        CH.gitFileDiff,
        root,
        "untracked.txt",
        false,
      ),
    ).toMatchObject({ original: "", modified: "new file\n", staged: false });
  });

  it("returns commit topology and refs for Git Graph", async () => {
    await service.invoke(CH.gitInit, root);
    await exec("git", ["-C", root, "config", "user.name", "Logos Tests"]);
    await exec("git", ["-C", root, "config", "user.email", "tests@logos.local"]);
    await fs.writeFile(path.join(root, "graph.txt"), "graph\n", "utf8");
    await service.invoke(CH.gitStage, root, ["graph.txt"]);
    await service.invoke(CH.gitCommit, root, "Graph commit");

    const graph = await service.invoke<GitGraphEntry[]>(CH.gitGraph, root, 10);
    expect(graph[0]).toMatchObject({ message: "Graph commit", parents: [] });
    expect(graph[0]?.refs.some(ref => ref.includes("HEAD"))).toBe(true);

    const details = await service.invoke<GitCommitDetails>(
      CH.gitCommitDetails,
      root,
      graph[0]!.hash,
    );
    expect(details).toMatchObject({
      message: "Graph commit",
      author: "Logos Tests",
      authorEmail: "tests@logos.local",
      files: [{ path: "graph.txt", additions: 1, deletions: 0, binary: false }],
    });
    await expect(
      service.invoke(CH.gitCommitDetails, root, "--all"),
    ).rejects.toThrow("Invalid commit hash");
    await expect(
      service.invoke(CH.gitCherryPick, root, "--all"),
    ).rejects.toThrow("Invalid commit hash");
    await expect(
      service.invoke(CH.gitRevert, root, "--all"),
    ).rejects.toThrow("Invalid commit hash");

    await service.invoke(CH.gitCreateBranch, root, "from-graph", graph[0]!.hash);
    expect((await service.invoke<GitStatus>(CH.gitStatus, root)).branch).toBe(
      "from-graph",
    );
  });
});
