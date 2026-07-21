import { describe, expect, it } from "@lightning-js/lightning";
import {
  buildLogosAgentSystemPrompt,
  DEFAULT_LOGOS_MODEL,
  isGpt56Model,
  logosOpenAIModels,
  LOGOS_AGENT_TOOLS,
  LOGOS_OPENAI_MODELS,
  resolveLogosOpenAIModel,
} from "./logos-agent";

describe("Logos agent contract", () => {
  it("publishes a unique, complete tool list", () => {
    expect(LOGOS_AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Bash",
      "Skill",
      "MCP",
      "DAP_REPL",
      "Finish",
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
    expect(prompt).toContain("Do not call Write, Bash, MCP, or DAP_REPL");
    expect(prompt).toContain("Finish is the only way to end the loop");
  });

  it("lists every multi-root workspace folder and explains absolute paths", () => {
    const prompt = buildLogosAgentSystemPrompt({
      workspace: ["/workspace/app", "/workspace/docs"],
      mode: "default",
    });
    expect(prompt).toContain("1. /workspace/app");
    expect(prompt).toContain("2. /workspace/docs");
    expect(prompt).toContain("Use absolute paths to work in another root");
  });

  it("publishes the GPT-5.6 series, modes, and effort capabilities", () => {
    expect(DEFAULT_LOGOS_MODEL).toBe("gpt-5.6-sol");
    expect(LOGOS_OPENAI_MODELS.slice(0, 12).map((model) => model.value)).toEqual([
      "gpt-5.6",
      "gpt-5.6-fast",
      "gpt-5.6-pro",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-sol-pro",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
      "gpt-5.6-terra-pro",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
      "gpt-5.6-luna-pro",
    ]);
    expect(LOGOS_OPENAI_MODELS[0]?.supportedEffortLevels).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(LOGOS_OPENAI_MODELS[12]?.supportedEffortLevels).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(new Set(LOGOS_OPENAI_MODELS.map((model) => model.value)).size).toBe(
      LOGOS_OPENAI_MODELS.length,
    );
    expect(
      logosOpenAIModels("chatgpt").some((model) => model.value.endsWith("-pro")),
    ).toBe(false);
    expect(
      logosOpenAIModels("chatgpt").some((model) => model.value === "gpt-5.6"),
    ).toBe(false);
    expect(
      logosOpenAIModels("api-key").some((model) => model.value === "gpt-5.6-pro"),
    ).toBe(true);
  });

  it("maps GPT-5.6 modes to Responses API fields and enforces OAuth limits", () => {
    expect(resolveLogosOpenAIModel("gpt-5.6-sol-fast", "api-key")).toEqual({
      apiModel: "gpt-5.6-sol",
      mode: "fast",
    });
    expect(resolveLogosOpenAIModel("gpt-5.6-terra-pro", "api-key")).toEqual({
      apiModel: "gpt-5.6-terra",
      mode: "pro",
    });
    expect(resolveLogosOpenAIModel("gpt-5.5", "chatgpt")).toEqual({
      apiModel: "gpt-5.5",
    });
    expect(() => resolveLogosOpenAIModel("gpt-5.6", "chatgpt")).toThrow(
      "requires gpt-5.6-sol",
    );
    expect(() =>
      resolveLogosOpenAIModel("gpt-5.6-luna-pro", "chatgpt"),
    ).toThrow("requires an OpenAI API key");
    expect(isGpt56Model("gpt-5.6-sol-2026-07-09")).toBe(true);
    expect(isGpt56Model("gpt-5.60")).toBe(false);
  });
});
