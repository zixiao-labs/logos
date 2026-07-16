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
import type { AgentEvent, AgentStartRequest } from "../../shared/types";
import { LogosAgentRuntime, type LogosAgentHooks } from "./logos-agent";
import type { OpenAIAuthStore } from "./openai-auth";

function responseStream(events: unknown[], lineEnding = "\n"): Response {
  return new Response(
    events
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
    expect(saved.history.length).toBe(2);
  });

  it("executes an approved write tool and continues the model loop", async () => {
    const target = path.join(root, "created.txt");
    await fs.writeFile(target, "old content", "utf8");
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
                  name: "write_file",
                  arguments: JSON.stringify({ path: "created.txt", content: "created" }),
                },
                {
                  type: "function_call",
                  id: "item-2",
                  call_id: "call-2",
                  name: "write_file",
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
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    }
    expect((await fs.readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(calls).toBe(2);
    expect(events.some((event) => event.kind === "tool-use" && event.name === "write_file")).toBe(true);
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
                  name: "read_file",
                  arguments: JSON.stringify({
                    path: "src/sample.txt",
                    start_line: 2,
                    limit: 1,
                  }),
                },
                {
                  type: "function_call",
                  call_id: "list-1",
                  name: "list_directory",
                  arguments: JSON.stringify({ path: "src" }),
                },
                {
                  type: "function_call",
                  call_id: "search-1",
                  name: "search",
                  arguments: JSON.stringify({ query: "needle", path: "src" }),
                },
                {
                  type: "function_call",
                  call_id: "command-1",
                  name: "run_command",
                  arguments: JSON.stringify({
                    command: process.execPath,
                    args: ["-e", "process.stdout.write('command-ok')"],
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
    expect(approvals).toEqual(["run_command"]);
    expect(calls).toBe(2);
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
                  name: "run_command",
                  arguments: JSON.stringify({
                    command: process.execPath,
                    args: [
                      "-e",
                      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`,
                    ],
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
        allowedTools: ["run_command"],
      }),
      hooks,
      fakeAuth(),
      sessionsDir,
    );

    await runtime.prompt("run a command");

    expect(approvals).toEqual(["run_command"]);
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
                  name: "read_file",
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
    globalThis.fetch = (async () => {
      calls += 1;
      return responseStream([
        {
          type: "response.completed",
          response: { id: `response-${calls}`, output: [] },
        },
      ]);
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

    await runtime.credentialsChanged();

    expect(calls).toBe(2);
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
                  name: "write_file",
                  arguments: JSON.stringify({ path: "denied.txt", content: "no" }),
                },
                {
                  type: "function_call",
                  call_id: "read-escape",
                  name: "read_file",
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
