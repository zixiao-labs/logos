import { describe, expect, it } from "@lightning-js/lightning";
import {
  buildLogosAgentSystemPrompt,
  LOGOS_AGENT_TOOLS,
} from "./logos-agent";

describe("Logos agent contract", () => {
  it("publishes a unique, complete tool list", () => {
    expect(LOGOS_AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_directory",
      "search",
      "write_file",
      "run_command",
    ]);
    expect(new Set(LOGOS_AGENT_TOOLS.map((tool) => tool.name)).size).toBe(
      LOGOS_AGENT_TOOLS.length,
    );
    expect(LOGOS_AGENT_TOOLS.every((tool) => tool.description && tool.constraints)).toBe(
      true,
    );
  });

  it("includes workspace, mode, workflow, and every tool in the system prompt", () => {
    const prompt = buildLogosAgentSystemPrompt({
      workspace: "/workspace/project",
      mode: "default",
    });

    expect(prompt).toContain("/workspace/project");
    expect(prompt).toContain("Ask for client approval");
    expect(prompt).toContain("Inspect relevant files");
    expect(prompt).toContain("run the narrowest useful test");
    for (const tool of LOGOS_AGENT_TOOLS) expect(prompt).toContain(tool.name);
  });

  it("makes plan mode explicitly read-only", () => {
    const prompt = buildLogosAgentSystemPrompt({ workspace: "/workspace", mode: "plan" });
    expect(prompt).toContain("Plan mode is read-only");
    expect(prompt).toContain("Do not call write_file or run_command");
  });
});
