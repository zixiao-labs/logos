import { afterEach, beforeEach, describe, expect, it } from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SKILL_FILES,
  setupWorkspaceAgents,
  workspaceAgentSetupStatus,
} from "./workspace-agent-setup";

describe("workspace Agent setup", () => {
  let temporary: string;
  let root: string;
  let template: string;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "logos-agent-setup-"));
    root = path.join(temporary, "workspace");
    template = path.join(temporary, "template");
    await fs.mkdir(root);
    for (const relative of SKILL_FILES) {
      const file = path.join(template, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `template:${relative}\n`, "utf8");
    }
  });

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("writes mainstream MCP formats and an open Agent Skill", async () => {
    const result = await setupWorkspaceAgents(
      { root, installMcp: true, installSkill: true },
      {
        debugMcpServerPath: "/opt/logos/debug-mcp/server.mjs",
        skillTemplateRoot: template,
      },
    );

    expect(result.mcp).toEqual({
      mcpJson: true,
      cursor: true,
      vscode: true,
      codex: true,
    });
    expect(result.skill).toBe(true);
    expect(result.changedFiles).toHaveLength(8);
    expect(JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8")))
      .toMatchObject({
        mcpServers: {
          "logos-debug": {
            command: "node",
            args: ["/opt/logos/debug-mcp/server.mjs", "--workspace", root],
          },
        },
      });
    expect(await fs.readFile(path.join(root, ".codex/config.toml"), "utf8"))
      .toContain('[mcp_servers."logos-debug"]');
    expect(await workspaceAgentSetupStatus(root)).toMatchObject({ skill: true });
  });

  it("preserves existing same-name server entries and skill files", async () => {
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "logos-debug": { command: "custom-command" },
          other: { command: "other-command" },
        },
      }),
      "utf8",
    );
    const skill = path.join(root, ".agents/skills/setup-launch-json/SKILL.md");
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.writeFile(skill, "custom skill\n", "utf8");

    await setupWorkspaceAgents(
      { root, installMcp: true, installSkill: true },
      {
        debugMcpServerPath: "/opt/logos/debug-mcp/server.mjs",
        skillTemplateRoot: template,
      },
    );

    const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["logos-debug"].command).toBe("custom-command");
    expect(mcp.mcpServers.other.command).toBe("other-command");
    expect(await fs.readFile(skill, "utf8")).toBe("custom skill\n");
  });
});
