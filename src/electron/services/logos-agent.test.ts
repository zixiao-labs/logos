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

function request(cwd: string): AgentStartRequest {
  return {
    sessionId: "thread-1",
    prompt: "",
    cwd,
    model: "gpt-test",
    permissionMode: "default",
    runtime: { type: "logos" },
  };
}

function fakeAuth(type: "none" | "api-key" = "api-key"): OpenAIAuthStore {
  return {
    status: async () => ({ type }),
    requestAuth: async () => ({
      type: "api-key",
      url: "https://api.openai.test/v1/responses",
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

    expect(await fs.readFile(path.join(root, "created.txt"), "utf8")).toBe("created");
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
