import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceAccessController } from "./workspace-access";

describe("workspace access controller", () => {
  let temporary: string;
  let workspace: string;
  let outside: string;
  let access: WorkspaceAccessController;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "logos-workspace-access-"));
    workspace = path.join(temporary, "workspace");
    outside = path.join(temporary, "outside");
    await Promise.all([fs.mkdir(workspace), fs.mkdir(outside)]);
    access = new WorkspaceAccessController();
    await access.restoreWorkspaceRoot(workspace);
  });

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("allows canonical workspace paths and rejects prefix and symlink escapes", async () => {
    const inside = path.join(workspace, "src", "new.ts");
    const sibling = path.join(temporary, "workspace-copy", "secret.ts");
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "secret");
    await fs.symlink(secret, path.join(workspace, "escape"));

    expect(await access.assertPath(inside, "write")).toBe(
      await access.canonicalize(inside),
    );
    await expect(
      access.assertPath(path.join(workspace, "..visible.ts"), "write"),
    ).resolves.toContain("..visible.ts");
    await expect(access.assertPath(sibling)).rejects.toThrow("outside");
    await expect(access.assertPath(path.join(workspace, "escape"))).rejects.toThrow(
      "outside",
    );
  });

  it("uses exact dialog grants and revokes them when the workspace changes", async () => {
    const granted = path.join(outside, "granted.txt");
    const other = path.join(outside, "other.txt");
    await access.grantPath(granted, ["read", "write"]);

    expect(await access.assertPath(granted, "write")).toBe(
      await access.canonicalize(granted),
    );
    await expect(access.assertPath(other)).rejects.toThrow("outside");

    const next = path.join(temporary, "next");
    await fs.mkdir(next);
    await access.restoreWorkspaceRoot(next);
    await expect(access.assertPath(granted)).rejects.toThrow("outside");
  });

  it("authorizes every root in a multi-root workspace", async () => {
    const second = path.join(temporary, "second");
    await fs.mkdir(second);
    const roots = await access.restoreWorkspaceRoots([workspace, second]);

    expect(access.currentRoots()).toEqual(roots);
    await expect(access.assertPath(path.join(second, "new.ts"), "write")).resolves.toContain(
      "new.ts",
    );
    await expect(access.assertWorkspaceRoot(second)).resolves.toBe(roots[1]);
    await expect(access.assertPath(path.join(outside, "secret.ts"))).rejects.toThrow("outside");
  });

  it("skips unavailable roots while retaining directory validation and deduplication", async () => {
    const second = path.join(temporary, "second");
    const missing = path.join(temporary, "missing");
    await fs.mkdir(second);

    const roots = await access.restoreWorkspaceRoots([missing, second, second]);
    expect(roots).toEqual([await fs.realpath(second)]);
    expect(access.currentRoots()).toEqual(roots);

    const file = path.join(temporary, "not-a-directory.txt");
    await fs.writeFile(file, "file", "utf8");
    await expect(access.restoreWorkspaceRoots([second, file])).rejects.toThrow(
      "must be directories",
    );
  });
});
