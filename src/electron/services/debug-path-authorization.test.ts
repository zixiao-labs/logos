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
import { authorizeDebugConfigurationPaths } from "./debug-path-authorization";
import { WorkspaceAccessController } from "./workspace-access";

describe("debug path authorization", () => {
  let temporary: string;
  let workspace: string;
  let access: WorkspaceAccessController;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "logos-debug-paths-"));
    workspace = path.join(temporary, "workspace");
    await fs.mkdir(path.join(workspace, "packages", "app"), { recursive: true });
    access = new WorkspaceAccessController();
    workspace = (await access.restoreWorkspaceRoot(workspace))!;
  });

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("resolves relative debug paths from a controlled cwd", async () => {
    const normalized = await authorizeDebugConfigurationPaths(access, {
      name: "Relative",
      type: "node",
      request: "launch",
      cwd: "packages/app",
      program: "src/main.js",
      file: "./index.js",
      script: "../script.js",
    });

    expect(normalized).toMatchObject({
      cwd: path.join(workspace, "packages", "app"),
      program: path.join(workspace, "packages", "app", "src", "main.js"),
      file: path.join(workspace, "packages", "app", "index.js"),
      script: path.join(workspace, "packages", "script.js"),
    });
  });

  it("rejects relative cwd and launch paths that escape the workspace", async () => {
    await expect(
      authorizeDebugConfigurationPaths(access, {
        name: "Escaping cwd",
        type: "node",
        request: "launch",
        cwd: "../outside",
      }),
    ).rejects.toThrow("outside");

    await expect(
      authorizeDebugConfigurationPaths(access, {
        name: "Escaping program",
        type: "node",
        request: "launch",
        cwd: "packages/app",
        program: "../../../outside.js",
      }),
    ).rejects.toThrow("outside");
  });
});
