import { afterEach, describe, expect, it } from "@lightning-js/lightning";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const validator = path.resolve(
  ".agents/skills/setup-launch-json/scripts/validate-launch-json.mjs",
);

describe("setup-launch-json skill validator", () => {
  let temporary = "";

  afterEach(async () => {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  });

  it("accepts this project's JSONC launch configuration", async () => {
    await expect(
      exec(process.execPath, [validator, "--workspace", process.cwd()]),
    ).resolves.toMatchObject({ stdout: expect.stringContaining("1 valid configuration") });
  });

  it("rejects unsupported editor orchestration", async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "logos-launch-skill-"));
    await fs.mkdir(path.join(temporary, ".logos"));
    await fs.writeFile(
      path.join(temporary, ".logos/launch.json"),
      JSON.stringify({
        version: "0.2.0",
        configurations: [
          {
            name: "Unsupported",
            type: "node",
            request: "launch",
            program: "${workspaceFolder}/app.js",
            preLaunchTask: "build",
          },
        ],
      }),
      "utf8",
    );
    let stderr = "";
    try {
      await exec(process.execPath, [validator, "--workspace", temporary]);
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? error);
    }
    expect(stderr).toContain("preLaunchTask is not supported");
  });
});
