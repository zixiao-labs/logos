import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AgentStartRequest } from "../../shared/types";
import { LogosAgentRuntime, type LogosAgentHooks } from "./logos-agent";
import type { OpenAIAuthStore } from "./openai-auth";

function responseStream(
  events: unknown[],
  lineEnding = "\n",
  autoFinish = true,
): Response {
  const normalized = events.map((value) => {
    if (!autoFinish || !value || typeof value !== "object") return value;
    const event = value as {
      type?: string;
      response?: { output?: Array<Record<string, unknown>> };
    };
    const output = event.response?.output;
    if (
      event.type !== "response.completed" ||
      !Array.isArray(output) ||
      output.some((item) => item.type === "function_call")
    ) return value;
    return {
      ...event,
      response: {
        ...event.response,
        output: [
          ...output,
          {
            type: "function_call",
            call_id: `finish-${crypto.randomUUID()}`,
            name: "Finish",
            arguments: JSON.stringify({ summary: "Test complete" }),
          },
        ],
      },
    };
  });
  return new Response(
    normalized
      .map((event) => `data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`)
      .join("") +
      `data: [DONE]${lineEnding}${lineEnding}`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function request(
  cwd: string,
  overrides: Partial<AgentStartRequest> = {},
): AgentStartRequest {
  return {
    sessionId: "thread-1",
    prompt: "",
    cwd,
    model: "gpt-test",
    permissionMode: "default",
    runtime: { type: "logos" },
    ...overrides,
  };
}

function fakeAuth(
  type: "none" | "api-key" | "chatgpt" = "api-key",
): OpenAIAuthStore {
  return {
    status: async () =>
      type === "none" ? { type } : { type, label: type },
    requestAuth: async () => ({
      type: type === "chatgpt" ? "chatgpt" : "api-key",
      url:
        type === "chatgpt"
          ? "https://chatgpt.test/codex/responses"
          : "https://api.openai.test/v1/responses",
      headers: { Authorization: "Bearer test" },
    }),
    loginChatGPT: async () => ({ type: "chatgpt" }),
  } as unknown as OpenAIAuthStore;
}

describe("Logos agent runtime", () => {
  let root: string;
  let sessionsDir: string;
  let originalFetch: typeof globalThis.fetch;
  let events: AgentEvent[];
  let hooks: LogosAgentHooks;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "logos-agent-"));
    sessionsDir = path.join(root, ".sessions");
    originalFetch = globalThis.fetch;
    events = [];
    hooks = {
      emit: (event) => events.push(event),
      requestPermission: async () => true,
      closed: () => undefined,
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("queues the prompt and advertises both login methods when unauthenticated", async () => {
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth("none"),
      sessionsDir,
    );

    await runtime.prompt("hello");

    const auth = events.find((event) => event.kind === "auth-required");
    expect(auth).toMatchObject({
      kind: "auth-required",
      methods: [
        { id: "chatgpt", type: "agent" },
        { id: "openai-api-key", type: "env_var" },
      ],
    });
    expect(events.some((event) => event.kind === "result")).toBe(false);
  });

  it("advertises GPT-5.6 models with an OAuth-compatible default", async () => {
    await LogosAgentRuntime.create(
      request(root, { model: "gpt-5.6-sol-pro" }),
      hooks,
      fakeAuth("chatgpt"),
      sessionsDir,
    );

    const ready = events.find((event) => event.kind === "runtime-ready");
    expect(ready).toMatchObject({
      kind: "runtime-ready",
      currentModelId: "gpt-5.6-sol",
    });
    if (ready?.kind !== "runtime-ready") throw new Error("Missing runtime-ready event");
    expect(ready.models.some((model) => model.value === "gpt-5.6-sol")).toBe(true);
    expect(ready.models.some((model) => model.value === "gpt-5.6")).toBe(false);
    expect(ready.models.some((model) => model.value === "gpt-5.6-terra-fast")).toBe(
      true,
    );
    expect(ready.models.some((model) => model.value.endsWith("-pro"))).toBe(false);
  });

  it("maps GPT-5.6 modes and efforts to Responses API fields", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responseStream([
        {
          type: "response.completed",
          response: { id: `response-${bodies.length}`, output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;

    const pro = await LogosAgentRuntime.create(
      request(root, { model: "gpt-5.6-sol-pro", effort: "max" }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );
    await pro.prompt("use pro reasoning");

    const fast = await LogosAgentRuntime.create(
      request(root, { model: "gpt-5.6-terra-fast", effort: "none" }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );
    await fast.prompt("use priority processing");

    const legacy = await LogosAgentRuntime.create(
      request(root, { model: "gpt-5.5", effort: "max" }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );
    await legacy.prompt("use a legacy model");

    fast.setEffort(undefined);
    await fast.prompt("use the default effort");

    expect(bodies[0]).toMatchObject({
      model: "gpt-5.6-sol",
      tool_choice: "required",
      reasoning: { effort: "max", mode: "pro", summary: "auto" },
      text: { verbosity: "low" },
    });
    expect(typeof bodies[0]?.prompt_cache_key).toBe("string");
    expect(bodies[1]).toMatchObject({
      model: "gpt-5.6-terra",
      service_tier: "priority",
      reasoning: { effort: "none", summary: "auto" },
    });
    expect(bodies[2]).toMatchObject({
      model: "gpt-5.5",
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(bodies[3]).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "medium", summary: "auto" },
    });
  });

  it("honors persisted legacy tool names in policy settings", async () => {
    let body: { tools?: Array<{ name: string }> } | undefined;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return responseStream([
        {
          type: "response.completed",
          response: { id: "response-policy", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root, { disallowedTools: ["write_file", "run_command"] }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("inspect only");

    expect(body?.tools?.some((tool) => tool.name === "Write")).toBe(false);
    expect(body?.tools?.some((tool) => tool.name === "Bash")).toBe(false);
    expect(body?.tools?.some((tool) => tool.name === "Finish")).toBe(true);
  });

  it("streams text, emits debug trace, and persists a resumable session", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream([
        { type: "response.output_text.delta", delta: "Hello from Logos" },
        {
          type: "response.completed",
          response: {
            id: "resp-1",
            output: [
              {
                type: "message",
                id: "message-1",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello from Logos" }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        },
      ], "\r\n");
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("hello");

    expect(events.some((event) => event.kind === "text-delta" && event.delta === "Hello from Logos")).toBe(true);
    expect(events.some((event) => event.kind === "system" && event.subtype === "logos-request")).toBe(true);
    expect(requestBody?.include).toEqual(["reasoning.encrypted_content"]);
    const result = events.find((event) => event.kind === "result");
    expect(result).toMatchObject({ kind: "result", isError: false });
    if (result?.kind !== "result" || !result.sdkSessionId) throw new Error("Missing runtime session id");
    const saved = JSON.parse(
      await fs.readFile(path.join(sessionsDir, `${result.sdkSessionId}.json`), "utf8"),
    ) as { history: unknown[] };
    expect(saved.history.length).toBe(4);
  });

  it("continues after assistant-only output until Finish is called", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream(
          [
            { type: "response.output_text.delta", delta: "I will inspect the project." },
            {
              type: "response.completed",
              response: {
                id: "resp-plan-only",
                output: [
                  {
                    type: "message",
                    id: "plan-only",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "I will inspect the project." },
                    ],
                  },
                ],
              },
            },
          ],
          "\n",
          false,
        );
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-finished", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("complete a task");

    expect(calls).toBe(2);
    expect(
      events.some(
        (event) => event.kind === "system" && event.subtype === "logos-continue",
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "result", isError: false });
  });

  it("rejects an invalid Finish call and keeps the loop running", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream(
          [
            {
              type: "response.completed",
              response: {
                id: "resp-invalid-finish",
                output: [
                  {
                    type: "function_call",
                    call_id: "invalid-finish",
                    name: "Finish",
                    arguments: JSON.stringify({ summary: "" }),
                  },
                ],
              },
            },
          ],
          "\n",
          false,
        );
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-valid-finish", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("finish correctly");

    expect(calls).toBe(2);
    expect(
      events.some(
        (event) =>
          event.kind === "system" &&
          event.subtype === "logos-finish" &&
          (event.data as { accepted?: boolean }).accepted === false,
      ),
    ).toBe(true);
  });

  it("keeps streamed function calls when response.completed has empty output", async () => {
    await fs.writeFile(path.join(root, "streamed.txt"), "streamed call", "utf8");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        const call = {
          type: "function_call",
          id: "stream-item",
          call_id: "stream-call",
          name: "Read",
          arguments: JSON.stringify({ path: "streamed.txt" }),
        };
        return responseStream(
          [
            { type: "response.output_item.added", output_index: 0, item: call },
            { type: "response.output_item.done", output_index: 0, item: call },
            {
              type: "response.completed",
              response: { id: "resp-stream-call", output: [] },
            },
          ],
          "\n",
          false,
        );
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-after-stream-call", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("read the file");

    expect(calls).toBe(2);
    expect(
      events.find(
        (event) => event.kind === "tool-result" && event.toolUseId === "stream-call",
      ),
    ).toMatchObject({ kind: "tool-result", isError: false });
  });

  it("executes an approved write tool and continues the model loop", async () => {
    const target = path.join(root, "created.txt");
    const largeTarget = path.join(root, "large.txt");
    const largeOldText = "a".repeat(600 * 1024);
    const largeNewText = "b".repeat(600 * 1024);
    await fs.writeFile(target, "old content", "utf8");
    await fs.writeFile(largeTarget, largeOldText, "utf8");
    await fs.chmod(target, 0o640);
    await fs.mkdir(path.join(root, "target-dir"));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-tool",
              output: [
                {
                  type: "function_call",
                  id: "item-1",
                  call_id: "call-1",
                  name: "Write",
                  arguments: JSON.stringify({ path: "created.txt", content: "created" }),
                },
                {
                  type: "function_call",
                  id: "item-2",
                  call_id: "large-write",
                  name: "Write",
                  arguments: JSON.stringify({ path: "large.txt", content: largeNewText }),
                },
                {
                  type: "function_call",
                  id: "item-3",
                  call_id: "call-2",
                  name: "Write",
                  arguments: JSON.stringify({ path: "target-dir", content: "blocked" }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        { type: "response.output_text.delta", delta: "Created the file." },
        {
          type: "response.completed",
          response: {
            id: "resp-done",
            output: [
              {
                type: "message",
                id: "message-2",
                role: "assistant",
                content: [{ type: "output_text", text: "Created the file." }],
              },
            ],
          },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("create a file");

    expect(await fs.readFile(target, "utf8")).toBe("created");
    expect(await fs.readFile(largeTarget, "utf8")).toBe(largeNewText);
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    }
    expect((await fs.readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(calls).toBe(2);
    expect(events.some((event) => event.kind === "tool-use" && event.name === "Write")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "tool-result" &&
          !event.isError &&
          event.diffs?.[0]?.newText === "created",
      ),
    ).toBe(true);
    expect(
      events.find(
        (event) => event.kind === "tool-result" && event.toolUseId === "call-2",
      ),
    ).toMatchObject({ kind: "tool-result", isError: true });
    const largeResult = events.find(
      (event) => event.kind === "tool-result" && event.toolUseId === "large-write",
    );
    expect(largeResult).toMatchObject({ kind: "tool-result", isError: false });
    expect(largeResult?.kind === "tool-result" ? largeResult.diffs : undefined).toBeUndefined();
  });

  it("executes read, list, search, and command tools with observable results", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src", "sample.txt"),
      "first line\nneedle line\nlast line",
      "utf8",
    );
    const approvals: string[] = [];
    hooks.requestPermission = async (_sessionId, toolName) => {
      approvals.push(toolName);
      return true;
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-tools",
              output: [
                {
                  type: "function_call",
                  call_id: "read-1",
                    name: "Read",
                  arguments: JSON.stringify({
                    path: "src/sample.txt",
                    start_line: 2,
                    limit: 1,
                  }),
                },
                {
                  type: "function_call",
                  call_id: "list-1",
                    name: "Glob",
                  arguments: JSON.stringify({ path: "src" }),
                },
                {
                  type: "function_call",
                  call_id: "search-1",
                    name: "Grep",
                    arguments: JSON.stringify({ pattern: "n[e]{2}dle", path: "src" }),
                },
                {
                  type: "function_call",
                  call_id: "command-1",
                    name: "Bash",
                    arguments: JSON.stringify({
                      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('command-ok')")}`,
                    }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: {
            id: "resp-tools-done",
            output: [
              {
                type: "message",
                id: "message-tools",
                role: "assistant",
                content: [{ type: "output_text", text: "Tool checks complete." }],
              },
            ],
          },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("test the tools");

    const result = (toolUseId: string) =>
      events.find(
        (event) => event.kind === "tool-result" && event.toolUseId === toolUseId,
      ) as Extract<AgentEvent, { kind: "tool-result" }> | undefined;
    expect(result("read-1")).toMatchObject({
      kind: "tool-result",
      isError: false,
      content: "2: needle line",
    });
    expect(result("list-1")?.content).toContain("sample.txt");
    expect(result("search-1")?.content).toContain("src/sample.txt:2:needle line");
    expect(result("command-1")?.content).toContain("command-ok");
    expect(approvals).toEqual(["Bash"]);
    expect(calls).toBe(2);
  });

  it("reads, searches, and writes across every workspace root", async () => {
    const additionalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "logos-agent-additional-"),
    );
    const thirdRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "logos-agent-third-"),
    );
    try {
      await fs.mkdir(path.join(additionalRoot, "src"));
      const sourcePath = path.join(additionalRoot, "src", "secondary.txt");
      const writtenPath = path.join(additionalRoot, "written.txt");
      await fs.writeFile(sourcePath, "secondary needle", "utf8");
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return responseStream([
            {
              type: "response.completed",
              response: {
                id: "resp-multi-root",
                output: [
                  {
                    type: "function_call",
                    call_id: "read-secondary",
                    name: "Read",
                    arguments: JSON.stringify({ path: sourcePath }),
                  },
                  {
                    type: "function_call",
                    call_id: "search-secondary",
                    name: "Grep",
                    arguments: JSON.stringify({
                      pattern: "needle",
                      path: path.join(additionalRoot, "src"),
                    }),
                  },
                  {
                    type: "function_call",
                    call_id: "write-secondary",
                    name: "Write",
                    arguments: JSON.stringify({
                      path: writtenPath,
                      content: "written from the agent",
                    }),
                  },
                ],
              },
            },
          ]);
        }
        return responseStream([
          {
            type: "response.completed",
            response: { id: "resp-multi-root-done", output: [] },
          },
        ]);
      }) as typeof globalThis.fetch;
      const runtime = await LogosAgentRuntime.create(
        request(root, { additionalDirectories: [additionalRoot, thirdRoot] }),
        hooks,
        fakeAuth(),
        sessionsDir,
      );

      await runtime.prompt("work in the second workspace root");

      const result = (toolUseId: string) =>
        events.find(
          (event) => event.kind === "tool-result" && event.toolUseId === toolUseId,
        ) as Extract<AgentEvent, { kind: "tool-result" }> | undefined;
      expect(result("read-secondary")?.content).toContain("secondary needle");
      const canonicalSourcePath = await fs.realpath(sourcePath);
      expect(result("search-secondary")).toMatchObject({
        isError: false,
        locations: [{ path: canonicalSourcePath, line: 1 }],
      });
      expect(result("write-secondary")?.isError).toBe(false);
      expect(await fs.readFile(writtenPath, "utf8")).toBe("written from the agent");
      expect(
        await runtime.matchesWorkspace(root, [thirdRoot, additionalRoot, thirdRoot, root]),
      ).toBe(true);
      expect(await runtime.matchesWorkspace(additionalRoot, [root])).toBe(false);
      expect(await runtime.matchesWorkspace(root, [path.join(root, "missing")])).toBe(false);
    } finally {
      await Promise.all([
        fs.rm(additionalRoot, { recursive: true, force: true }),
        fs.rm(thirdRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("restores a multi-root session when saved roots are reordered", async () => {
    const additionalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "logos-agent-restore-additional-"),
    );
    const thirdRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "logos-agent-restore-third-"),
    );
    try {
      const resume = "saved-session";
      const [canonicalRoot, canonicalAdditional, canonicalThird] = await Promise.all([
        fs.realpath(root),
        fs.realpath(additionalRoot),
        fs.realpath(thirdRoot),
      ]);
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, `${resume}.json`),
        JSON.stringify({
          cwd: canonicalRoot,
          workspaceFolders: [
            canonicalThird,
            canonicalRoot,
            canonicalAdditional,
            canonicalThird,
          ],
          history: [],
        }),
        "utf8",
      );

      await LogosAgentRuntime.create(
        request(root, {
          resume,
          additionalDirectories: [additionalRoot, thirdRoot],
        }),
        hooks,
        fakeAuth(),
        sessionsDir,
      );

      expect(
        events.some(
          event => event.kind === "system" && event.subtype === "logos-session-restored",
        ),
      ).toBe(true);
    } finally {
      await Promise.all([
        fs.rm(additionalRoot, { recursive: true, force: true }),
        fs.rm(thirdRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("loads project skills through the Skill tool", async () => {
    const skillDir = path.join(root, ".agents", "skills", "review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Review\n\nCheck behavior before style.",
      "utf8",
    );
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-skill",
              output: [
                {
                  type: "function_call",
                  call_id: "skill-list",
                  name: "Skill",
                  arguments: "{}",
                },
                {
                  type: "function_call",
                  call_id: "skill-load",
                  name: "Skill",
                  arguments: JSON.stringify({ name: "review" }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-skill-done", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root, { settingSources: ["project"] }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("load the review skill");

    const results = events.filter((event) => event.kind === "tool-result");
    expect(results.find((event) => event.toolUseId === "skill-list")?.content).toBe(
      "review\tproject",
    );
    expect(results.find((event) => event.toolUseId === "skill-load")?.content).toContain(
      "Check behavior before style",
    );
  });

  it("requires one-time approval for DAP REPL even in bypass mode", async () => {
    const approvals: Array<{ name: string; options: unknown }> = [];
    hooks.requestPermission = async (_sessionId, name, _input, options) => {
      approvals.push({ name, options });
      return true;
    };
    const debugRequests: unknown[] = [];
    hooks.debug = {
      list: () => [
        {
          id: "debug-1",
          name: "Node",
          debugType: "node",
          request: "launch",
          status: "stopped",
          capabilities: {},
        },
      ],
      generation: () => "debug-generation-1",
      start: async request => ({
        id: request.sessionId ?? "debug-started",
        name: request.configuration.name,
        debugType: request.configuration.type,
        request: request.configuration.request,
        status: "running",
        capabilities: {},
      }),
      stop: async () => undefined,
      restart: async () => ({
        id: "debug-1",
        name: "Node",
        debugType: "node",
        request: "launch",
        status: "running",
        capabilities: {},
      }),
      configurations: async () => ({ path: null, configurations: [] }),
      startConfiguration: async () => ({
        id: "debug-started",
        name: "Node",
        debugType: "node",
        request: "launch",
        status: "running",
        capabilities: {},
      }),
      setBreakpoints: async () => [],
      request: async <T = unknown>(sessionId: string, command: string, args?: Record<string, unknown>) => {
        debugRequests.push({ sessionId, command, args });
        return {
          seq: 1,
          type: "response",
          request_seq: 1,
          success: true,
          command,
          body: { result: "42", variablesReference: 0 } as T,
        };
      },
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-dap",
              output: [
                {
                  type: "function_call",
                  call_id: "dap-1",
                  name: "DAP_REPL",
                  arguments: JSON.stringify({ expression: "6 * 7", frame_id: 3 }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-dap-done", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root, { permissionMode: "bypassPermissions" }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("evaluate the expression");

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.name).toBe("DAP_REPL");
    expect(approvals[0]?.options).toHaveLength(2);
    expect(debugRequests).toEqual([
      {
        sessionId: "debug-1",
        command: "evaluate",
        args: { expression: "6 * 7", context: "repl", frameId: 3 },
      },
    ]);
  });

  it("inspects with DAP without approval and approves mutating DAP actions", async () => {
    const approvals: Array<{ name: string; input: unknown }> = [];
    hooks.requestPermission = async (_sessionId, name, input) => {
      approvals.push({ name, input });
      return true;
    };
    const session = {
      id: "debug-structured",
      name: "Node",
      debugType: "node",
      request: "launch" as const,
      status: "stopped" as const,
      capabilities: {},
    };
    const requests: unknown[] = [];
    hooks.debug = {
      list: () => [session],
      generation: () => "structured-generation",
      start: async () => session,
      stop: async () => undefined,
      restart: async () => session,
      configurations: async () => ({ path: null, configurations: [] }),
      startConfiguration: async () => session,
      setBreakpoints: async () => [],
      request: async <T = unknown>(sessionId: string, command: string, args?: Record<string, unknown>) => {
        requests.push({ sessionId, command, args });
        return {
          seq: 1,
          type: "response",
          request_seq: 1,
          success: true,
          command,
          body: { result: "42", variablesReference: 0 } as T,
        };
      },
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const output = calls === 1
        ? [{
            type: "function_call",
            call_id: "dap-list",
            name: "DAP",
            arguments: JSON.stringify({ action: "list_sessions" }),
          }]
        : calls === 2
          ? [{
              type: "function_call",
              call_id: "dap-evaluate",
              name: "DAP",
              arguments: JSON.stringify({ action: "evaluate", expression: "6 * 7" }),
            }]
          : [{
              type: "function_call",
              call_id: "finish-dap",
              name: "Finish",
              arguments: JSON.stringify({ summary: "Debug inspection complete" }),
            }];
      return responseStream([
        {
          type: "response.completed",
          response: { id: `resp-dap-${calls}`, output },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root, { permissionMode: "bypassPermissions" }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("inspect and evaluate the debugger");

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      name: "DAP",
      input: { action: "evaluate", session_id: "debug-structured" },
    });
    expect(requests).toEqual([
      {
        sessionId: "debug-structured",
        command: "evaluate",
        args: { expression: "6 * 7", context: "repl" },
      },
    ]);
    expect(
      events.find(event => event.kind === "tool-result" && event.toolUseId === "dap-list"),
    ).toMatchObject({ content: expect.stringContaining("debug-structured") });
  });

  it("lists and calls a workspace MCP server behind one-time approvals", async () => {
    const require = createRequire(import.meta.url);
    const serverModule = require.resolve("@modelcontextprotocol/sdk/server/index.js");
    const stdioModule = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const typesModule = require.resolve("@modelcontextprotocol/sdk/types.js");
    const serverFile = path.join(root, "mcp-server.cjs");
    await fs.writeFile(
      serverFile,
      `const { Server } = require(${JSON.stringify(serverModule)});
const { StdioServerTransport } = require(${JSON.stringify(stdioModule)});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(typesModule)});
const server = new Server({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const value = String(request.params.arguments?.value ?? "");
  return { content: [{ type: "text", text: value }], ...(value === "mcp-fail" ? { isError: true } : {}) };
});
void server.connect(new StdioServerTransport());
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: process.execPath, args: [serverFile] },
        },
      }),
      "utf8",
    );
    const approvals: Array<{ name: string; options: unknown }> = [];
    hooks.requestPermission = async (_sessionId, name, _input, options) => {
      approvals.push({ name, options });
      return true;
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-mcp",
              output: [
                {
                  type: "function_call",
                  call_id: "mcp-servers",
                  name: "MCP",
                  arguments: JSON.stringify({ action: "list_servers" }),
                },
                {
                  type: "function_call",
                  call_id: "mcp-tools",
                  name: "MCP",
                  arguments: JSON.stringify({ action: "list_tools", server: "local" }),
                },
                {
                  type: "function_call",
                  call_id: "mcp-call",
                  name: "MCP",
                  arguments: JSON.stringify({
                    action: "call_tool",
                    server: "local",
                    tool: "echo",
                    arguments: { value: "mcp-ok" },
                  }),
                },
                {
                  type: "function_call",
                  call_id: "mcp-fail",
                  name: "MCP",
                  arguments: JSON.stringify({
                    action: "call_tool",
                    server: "local",
                    tool: "echo",
                    arguments: { value: "mcp-fail" },
                  }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-mcp-done", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root, { permissionMode: "bypassPermissions" }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    try {
      await runtime.prompt("use the MCP server");
    } finally {
      await runtime.dispose();
    }

    expect(approvals.map((approval) => approval.name)).toEqual([
      "MCP",
      "MCP",
      "MCP",
    ]);
    expect(approvals.every((approval) => Array.isArray(approval.options))).toBe(true);
    const result = (id: string) =>
      events.find(
        (event) => event.kind === "tool-result" && event.toolUseId === id,
      ) as Extract<AgentEvent, { kind: "tool-result" }> | undefined;
    expect(result("mcp-servers")?.content).toContain("local\tstdio");
    expect(result("mcp-tools")?.content).toContain("echo");
    expect(result("mcp-call")?.content).toBe("mcp-ok");
    expect(result("mcp-fail")).toMatchObject({
      kind: "tool-result",
      content: "MCP tool error: mcp-fail",
      isError: true,
    });
  });

  it("rejects an MCP config changed while approval is pending", async () => {
    const configFile = path.join(root, ".mcp.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({
        mcpServers: { local: { command: process.execPath, args: ["safe.cjs"] } },
      }),
      "utf8",
    );
    hooks.requestPermission = async () => {
      await fs.writeFile(
        configFile,
        JSON.stringify({
          mcpServers: { local: { command: process.execPath, args: ["changed.cjs"] } },
        }),
        "utf8",
      );
      return true;
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-mcp-race",
              output: [
                {
                  type: "function_call",
                  call_id: "mcp-race",
                  name: "MCP",
                  arguments: JSON.stringify({ action: "list_tools", server: "local" }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-mcp-race-done", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("list MCP tools");

    expect(
      events.find(
        (event) => event.kind === "tool-result" && event.toolUseId === "mcp-race",
      ),
    ).toMatchObject({ kind: "tool-result", isError: true });
    const result = events.find(
      (event) => event.kind === "tool-result" && event.toolUseId === "mcp-race",
    );
    expect(result?.kind === "tool-result" && result.content).toContain(
      "changed after approval",
    );
  });

  it("requires explicit approval for commands in bypass mode", async () => {
    const marker = path.join(root, "command-ran.txt");
    const approvals: string[] = [];
    hooks.requestPermission = async (_sessionId, toolName) => {
      approvals.push(toolName);
      return false;
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-command",
              output: [
                {
                  type: "function_call",
                  call_id: "command-bypass",
                  name: "Bash",
                  arguments: JSON.stringify({
                    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
                      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`,
                    )}`,
                  }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-command-done", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root, {
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash"],
      }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("run a command");

    expect(approvals).toEqual(["Bash"]);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    expect(
      events.find(
        (event) =>
          event.kind === "tool-result" && event.toolUseId === "command-bypass",
      ),
    ).toMatchObject({ kind: "tool-result", isError: true, content: "Denied by user" });
  });

  it("byte-limits error tool output before emitting or replaying it", async () => {
    const escapedPath = `../${"x".repeat(1024 * 1024)}`;
    let calls = 0;
    let replayedOutput: string | undefined;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-large-error",
              output: [
                {
                  type: "function_call",
                  call_id: "large-error",
                  name: "Read",
                  arguments: JSON.stringify({ path: escapedPath }),
                },
              ],
            },
          },
        ]);
      }
      const body = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> };
      replayedOutput = body.input?.find(
        (item) => item.type === "function_call_output",
      )?.output as string | undefined;
      return responseStream([
        {
          type: "response.completed",
          response: { id: "resp-large-error-done", output: [] },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("read outside the workspace");

    const result = events.find(
      (event) => event.kind === "tool-result" && event.toolUseId === "large-error",
    );
    if (result?.kind !== "tool-result") throw new Error("Missing tool result");
    expect(result.isError).toBe(true);
    expect(result.content.startsWith("Path is outside the workspace:")).toBe(true);
    expect(result.content.endsWith("...[truncated]")).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1024 * 1024);
    expect(replayedOutput).toBe(result.content);
  });

  it("awaits queued prompts serially after credentials change", async () => {
    let authenticated = false;
    const auth = {
      status: async () =>
        authenticated
          ? ({ type: "api-key", label: "OpenAI API key" } as const)
          : ({ type: "none" } as const),
      requestAuth: async () => ({
        type: "api-key" as const,
        url: "https://api.openai.test/v1/responses",
        headers: { Authorization: "Bearer test" },
      }),
    } as unknown as OpenAIAuthStore;
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    globalThis.fetch = (async () => {
      const call = ++calls;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (call === 1) {
          markFirstStarted();
          await firstRelease;
        }
        return responseStream([
          {
            type: "response.completed",
            response: { id: `response-${call}`, output: [] },
          },
        ]);
      } finally {
        inFlight -= 1;
      }
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      auth,
      sessionsDir,
    );
    await runtime.prompt("first");
    await runtime.prompt("second");
    authenticated = true;

    const draining = runtime.credentialsChanged();
    await firstStarted;
    try {
      expect(calls).toBe(1);
    } finally {
      releaseFirst();
    }
    await draining;

    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(events.filter((event) => event.kind === "result").length).toBe(2);
  });

  it("reports denied mutations and workspace path escapes as tool errors", async () => {
    hooks.requestPermission = async () => false;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return responseStream([
          {
            type: "response.completed",
            response: {
              id: "resp-denied",
              output: [
                {
                  type: "function_call",
                  call_id: "write-denied",
                  name: "Write",
                  arguments: JSON.stringify({ path: "denied.txt", content: "no" }),
                },
                {
                  type: "function_call",
                  call_id: "read-escape",
                  name: "Read",
                  arguments: JSON.stringify({ path: "../outside.txt" }),
                },
              ],
            },
          },
        ]);
      }
      return responseStream([
        {
          type: "response.completed",
          response: {
            id: "resp-denied-done",
            output: [
              {
                type: "message",
                id: "message-denied",
                role: "assistant",
                content: [{ type: "output_text", text: "The operations were blocked." }],
              },
            ],
          },
        },
      ]);
    }) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("try unsafe operations");

    expect(await fs.stat(path.join(root, "denied.txt")).catch(() => null)).toBeNull();
    expect(
      events.find(
        (event) => event.kind === "tool-result" && event.toolUseId === "write-denied",
      ),
    ).toMatchObject({ kind: "tool-result", isError: true, content: "Denied by user" });
    const escaped = events.find(
      (event) => event.kind === "tool-result" && event.toolUseId === "read-escape",
    );
    expect(escaped).toMatchObject({ kind: "tool-result", isError: true });
    expect(escaped?.kind === "tool-result" && escaped.content).toContain(
      "outside the workspace",
    );
  });

  it("reports a stream that ends without a terminal response as an error", async () => {
    globalThis.fetch = (async () =>
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof globalThis.fetch;
    const runtime = await LogosAgentRuntime.create(
      request(root),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("hello");

    expect(
      events.some(
        (event) =>
          event.kind === "error" && event.message.includes("before response.completed"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "result")).toBe(false);
  });
});
