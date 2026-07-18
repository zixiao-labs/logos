import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { DapEvaluateResult, DapResponse, DebugSessionInfo } from "../../shared/dap";
import type {
  AgentAuthMethod,
  AgentEffortLevel,
  AgentEvent,
  AgentPermissionMode,
  AgentStartRequest,
  AgentToolDiff,
  AgentToolLocation,
} from "../../shared/types";
import {
  buildLogosAgentSystemPrompt,
  DEFAULT_LOGOS_MODEL,
  isGpt56Model,
  logosOpenAIModels,
  LOGOS_AGENT_TOOLS,
  resolveLogosOpenAIModel,
} from "../../shared/logos-agent";
import type { OpenAIAuthStore } from "./openai-auth";
import { WorkspaceMcpClient, type McpToolInput } from "./mcp-client";

const MAX_STEPS = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const HIGH_RISK_PERMISSION_OPTIONS = [
  { id: "allow-once", name: "Allow once", kind: "allow_once" as const },
  { id: "reject-once", name: "Deny", kind: "reject_once" as const },
];
const LEGACY_TOOL_NAMES: Record<string, string> = {
  read_file: "Read",
  list_directory: "Glob",
  search: "Grep",
  write_file: "Write",
  run_command: "Bash",
};
const GREP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const constants = require("node:fs").constants;
const fs = require("node:fs/promises");
const path = require("node:path");
const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", "release"]);
const matcher = new RegExp(workerData.pattern, workerData.caseSensitive ? "" : "i");
const include = workerData.includeSource ? new RegExp(workerData.includeSource) : null;
const matches = [];
async function walk(current) {
  if (matches.length >= 100) return;
  const real = await fs.realpath(current);
  const relativeToRoot = path.relative(workerData.workspaceRoot, real);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Grep path resolves outside the workspace");
  }
  const stat = await fs.lstat(real);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (stat.size > 1024 * 1024) return;
    const relative = path.relative(workerData.workspaceRoot, real).split(path.sep).join("/");
    if (include && !include.test(relative) && !include.test(path.basename(relative))) return;
    const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let source;
    try {
      if ((await handle.stat()).size > 1024 * 1024) return;
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (source.includes("\0")) return;
    for (const [index, line] of source.split("\n").entries()) {
      if (matches.length >= 100) break;
      if (matcher.test(line)) matches.push({ path: relative, line: index + 1, text: line.slice(0, 4000) });
    }
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(real, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= 100) break;
    if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
    try {
      await walk(path.join(real, entry.name));
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
  }
}
walk(workerData.root).then(() => parentPort.postMessage(matches), (error) => {
  throw error;
});
`;

type InputItem = Record<string, unknown>;

interface FunctionCall extends Record<string, unknown> {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
  id?: string;
}

interface ResponsesResult {
  output: InputItem[];
  calls: FunctionCall[];
  text: string;
  usage?: unknown;
  responseId?: string;
}

interface ToolResult {
  output: string;
  isError?: boolean;
  locations?: AgentToolLocation[];
  diffs?: AgentToolDiff[];
}

export interface LogosAgentHooks {
  emit(event: AgentEvent): void;
  requestPermission(
    sessionId: string,
    toolName: string,
    input: unknown,
    options?: typeof HIGH_RISK_PERMISSION_OPTIONS,
  ): Promise<boolean>;
  debug?: {
    list(): DebugSessionInfo[];
    generation(sessionId: string): string | undefined;
    request<T = unknown>(
      sessionId: string,
      command: string,
      args?: Record<string, unknown>,
    ): Promise<DapResponse<T>>;
  };
  closed(sessionId: string): void;
}

const AUTH_METHODS: AgentAuthMethod[] = [
  {
    id: "chatgpt",
    name: "ChatGPT Plus/Pro",
    description: "Sign in with a ChatGPT subscription in your browser.",
    type: "agent",
  },
  {
    id: "openai-api-key",
    name: "OpenAI API key",
    description: "Store an API key in the operating system credential vault.",
    type: "env_var",
    variables: [
      {
        name: "OPENAI_API_KEY",
        label: "OpenAI API key",
        secret: true,
        optional: false,
      },
    ],
  },
];

function toolDescription(name: string): string {
  const tool = LOGOS_AGENT_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Logos tool metadata: ${name}`);
  return `${tool.description} ${tool.constraints}`;
}

const TOOLS = [
  {
    type: "function",
    name: "Read",
    description: toolDescription("Read"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative or absolute file path" },
        start_line: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 4000 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Glob",
    description: toolDescription("Glob"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Grep",
    description: toolDescription("Grep"),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        path: { type: "string" },
        include: { type: "string", description: "Optional file glob such as **/*.ts" },
        case_sensitive: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Write",
    description: toolDescription("Write"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Bash",
    description: toolDescription("Bash"),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Skill",
    description: toolDescription("Skill"),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill directory name; omit to list skills" },
        path: { type: "string", description: "File relative to the skill; defaults to SKILL.md" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "MCP",
    description: toolDescription("MCP"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list_servers", "list_tools", "call_tool"],
        },
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "DAP_REPL",
    description: toolDescription("DAP_REPL"),
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string" },
        session_id: { type: "string", description: "Optional when exactly one debug session is active" },
        frame_id: { type: "integer" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "Finish",
    description: toolDescription("Finish"),
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Concise completion summary" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function byteLimit(value: string, max = MAX_TOOL_OUTPUT_BYTES): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= max) return value;
  const marker = "\n...[truncated]";
  const contentBytes = Math.max(0, max - Buffer.byteLength(marker));
  let content = buffer.subarray(0, contentBytes).toString("utf8");
  while (Buffer.byteLength(content) > contentBytes) {
    content = content.replace(/[\s\S]$/u, "");
  }
  return `${content}${marker}`;
}

function commandOutput(output: string, status: string): string {
  const suffix = `\n[${status}]`;
  return `${byteLimit(
    output,
    Math.max(0, MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(suffix)),
  )}${suffix}`.trim();
}

function normalizeFunctionCall(item: InputItem): FunctionCall | null {
  if (item.type !== "function_call" || typeof item.name !== "string") return null;
  const callId =
    typeof item.call_id === "string"
      ? item.call_id
      : typeof item.id === "string"
        ? item.id
        : null;
  if (!callId) return null;
  let args: string;
  if (typeof item.arguments === "string") args = item.arguments;
  else if (item.arguments && typeof item.arguments === "object") {
    args = JSON.stringify(item.arguments);
  } else return null;
  return { ...item, type: "function_call", name: item.name, arguments: args, call_id: callId };
}

function responseItemKey(item: InputItem, fallback: number | string): string {
  return String(item.call_id ?? item.id ?? fallback);
}

function normalizeToolPolicy(tools: string[] | undefined): string[] {
  return (tools ?? []).map((name) => LEGACY_TOOL_NAMES[name] ?? name);
}

function mergeResponseOutput(
  streamed: InputItem[],
  completed: InputItem[] | undefined,
): InputItem[] {
  if (!completed?.length) return streamed;
  const merged = new Map<string, InputItem>();
  streamed.forEach((item, index) => merged.set(responseItemKey(item, `s:${index}`), item));
  completed.forEach((item, index) => merged.set(responseItemKey(item, `c:${index}`), item));
  return [...merged.values()];
}

function replayableOutput(item: InputItem): boolean {
  return item.type !== "reasoning" || typeof item.encrypted_content === "string";
}

function stopProcessTree(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const force = setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.unref();
      return;
    }
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* process already exited */
    }
  }, 1000);
  force.unref();
  child.once("exit", () => clearTimeout(force));
}

export class LogosAgentRuntime {
  private readonly sessionId: string;
  private history: InputItem[] = [];
  private model: string;
  private effort?: AgentEffortLevel;
  private mode: AgentPermissionMode;
  private allowedTools: string[];
  private disallowedTools: string[];
  private abortController: AbortController | null = null;
  private activeToolProcess: ChildProcess | null = null;
  private activeSearchWorker: Worker | null = null;
  private pendingPrompts: string[] = [];
  private running = false;
  private disposed = false;
  private readonly mcp: WorkspaceMcpClient;
  private readonly approvedMcpConfigs = new WeakMap<object, string>();
  private readonly approvedDapGenerations = new WeakMap<object, string>();

  private constructor(
    private readonly request: AgentStartRequest,
    private readonly hooks: LogosAgentHooks,
    private readonly auth: OpenAIAuthStore,
    private readonly sessionsDir: string,
    private readonly workspaceRoot: string,
  ) {
    this.sessionId =
      request.resume && /^[A-Za-z0-9_-]{1,128}$/.test(request.resume)
        ? request.resume
        : crypto.randomUUID();
    this.model = request.model || DEFAULT_LOGOS_MODEL;
    this.effort = request.effort;
    this.mode = request.permissionMode ?? "default";
    this.allowedTools = normalizeToolPolicy(request.allowedTools);
    this.disallowedTools = normalizeToolPolicy(request.disallowedTools);
    this.mcp = new WorkspaceMcpClient(workspaceRoot);
  }

  static async create(
    request: AgentStartRequest,
    hooks: LogosAgentHooks,
    auth: OpenAIAuthStore,
    sessionsDir: string,
  ): Promise<LogosAgentRuntime> {
    const workspaceRoot = await fs.realpath(request.cwd);
    const runtime = new LogosAgentRuntime(
      request,
      hooks,
      auth,
      sessionsDir,
      workspaceRoot,
    );
    await runtime.restore();
    await runtime.emitReady();
    return runtime;
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("The Logos agent is closed");
    if (this.running) throw new Error("The Logos agent is already running");
    if ((await this.auth.status()).type === "none") {
      this.pendingPrompts.push(text);
      this.hooks.emit({
        kind: "auth-required",
        sessionId: this.request.sessionId,
        methods: AUTH_METHODS,
        message: "Connect ChatGPT or add an OpenAI API key.",
      });
      return;
    }
    this.running = true;
    const started = Date.now();
    const historyStart = this.history.length;
    this.abortController = new AbortController();
    this.history.push({
      role: "user",
      content: [{ type: "input_text", text }],
    });
    this.trace("input", { text });
    try {
      let usage: unknown;
      for (let step = 0; step < MAX_STEPS; step++) {
        const result = await this.requestTurn(step);
        usage = result.usage ?? usage;
        this.history.push(...result.output);
        if (result.calls.length === 0) {
          this.trace("continue", {
            step,
            reason: "The model returned without calling Finish or another tool",
          });
          this.history.push({
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Continue the current task now. Use the available tools for remaining work, or call Finish with the final summary if and only if everything is complete.",
              },
            ],
          });
          await this.persist();
          continue;
        }
        let finished = false;
        for (const call of result.calls) {
          if (call.name === "Finish") {
            let summary = "";
            try {
              const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
              summary = typeof input.summary === "string" ? input.summary.trim() : "";
            } catch {
              // The invalid call is returned to the model below so it can retry.
            }
            const finishError =
              result.calls.length !== 1
                ? "Finish must be the only function call in its response"
                : !summary
                  ? "Finish requires a non-empty summary"
                  : null;
            finished = !finishError;
            this.trace("finish", {
              callId: call.call_id,
              arguments: call.arguments,
              accepted: finished,
            });
            this.history.push({
              type: "function_call_output",
              call_id: call.call_id,
              output: finishError ?? "Task marked complete",
            });
            if (finished && !result.text.trim()) {
              this.hooks.emit({
                kind: "text",
                sessionId: this.request.sessionId,
                messageId: crypto.randomUUID(),
                text: summary,
              });
            }
            continue;
          }
          const toolResult = await this.executeCall(call);
          this.history.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: toolResult.output,
          });
        }
        await this.persist();
        if (finished) {
          this.hooks.emit({
            kind: "result",
            sessionId: this.request.sessionId,
            sdkSessionId: this.sessionId,
            isError: false,
            durationMs: Date.now() - started,
            costUsd: null,
            usage: usage ?? {},
          });
          return;
        }
      }
      throw new Error(`Agent stopped after ${MAX_STEPS} steps without calling Finish`);
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        this.hooks.emit({
          kind: "result",
          sessionId: this.request.sessionId,
          sdkSessionId: this.sessionId,
          isError: true,
          durationMs: Date.now() - started,
          costUsd: null,
          usage: { stopReason: "cancelled" },
        });
      } else if (
        /401|403|unauthor|forbidden|authentication required|invalid.*token|token refresh/i.test(
          String(error),
        )
      ) {
        this.pendingPrompts.push(text);
        this.history.splice(historyStart);
        await this.persist().catch(() => undefined);
        this.hooks.emit({
          kind: "auth-required",
          sessionId: this.request.sessionId,
          methods: AUTH_METHODS,
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        this.trace("error", { message: error instanceof Error ? error.message : String(error) });
        this.hooks.emit({
          kind: "error",
          sessionId: this.request.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  async authenticate(methodId: string): Promise<void> {
    if (methodId !== "chatgpt") {
      throw new Error("Add the OpenAI API key in Settings, then retry.");
    }
    await this.auth.loginChatGPT();
    await this.credentialsChanged();
  }

  async credentialsChanged(): Promise<void> {
    await this.emitReady();
    const pending = this.pendingPrompts.splice(0);
    for (const prompt of pending) await this.prompt(prompt);
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
    if (this.activeToolProcess) stopProcessTree(this.activeToolProcess);
    if (this.activeSearchWorker) await this.activeSearchWorker.terminate();
    if (this.pendingPrompts.length > 0) {
      this.pendingPrompts = [];
      this.hooks.emit({
        kind: "result",
        sessionId: this.request.sessionId,
        sdkSessionId: this.sessionId,
        isError: true,
        durationMs: 0,
        costUsd: null,
        usage: { stopReason: "cancelled" },
      });
    }
  }

  async matchesWorkspace(cwd: string): Promise<boolean> {
    return fs
      .realpath(cwd)
      .then((candidate) => candidate === this.workspaceRoot)
      .catch(() => false);
  }

  async setMode(modeId: string): Promise<void> {
    if (
      modeId !== "default" &&
      modeId !== "acceptEdits" &&
      modeId !== "bypassPermissions" &&
      modeId !== "plan"
    ) {
      throw new Error(`Unsupported Logos agent mode: ${modeId}`);
    }
    this.mode = modeId;
    this.hooks.emit({ kind: "mode", sessionId: this.request.sessionId, modeId });
  }

  async setModel(modelId: string): Promise<void> {
    this.model = modelId || DEFAULT_LOGOS_MODEL;
    await this.emitReady();
  }

  setEffort(effort?: AgentEffortLevel): void {
    this.effort = effort;
  }

  setToolPolicy(allowed?: string[], disallowed?: string[]): void {
    this.allowedTools = normalizeToolPolicy(allowed);
    this.disallowedTools = normalizeToolPolicy(disallowed);
  }

  async dispose(removeHistory = false): Promise<void> {
    this.disposed = true;
    this.abortController?.abort();
    if (this.activeToolProcess) stopProcessTree(this.activeToolProcess);
    if (this.activeSearchWorker) await this.activeSearchWorker.terminate();
    await this.mcp.close();
    if (removeHistory) await fs.rm(this.sessionFile(), { force: true });
    else await this.persist().catch(() => undefined);
  }

  private async requestTurn(step: number): Promise<ResponsesResult> {
    const auth = await this.auth.requestAuth(this.request.baseUrl || "https://api.openai.com/v1");
    const messageId = crypto.randomUUID();
    const tools = TOOLS.filter(
      (tool) =>
        (tool.name === "Finish" || !this.disallowedTools.includes(tool.name)) &&
        (this.mode !== "plan" ||
          (tool.name !== "Write" &&
            tool.name !== "Bash" &&
            tool.name !== "MCP" &&
            tool.name !== "DAP_REPL")),
    );
    const target = resolveLogosOpenAIModel(this.model, auth.type);
    const gpt56 = isGpt56Model(target.apiModel);
    const effort =
      this.effort === "max" && !gpt56
        ? "high"
        : (this.effort ?? (gpt56 ? "medium" : undefined));
    const reasoning =
      effort || target.mode === "pro"
        ? {
            ...(effort ? { effort } : {}),
            ...(target.mode === "pro" ? { mode: "pro" as const } : {}),
            summary: "auto" as const,
          }
        : undefined;
    const body = {
      model: target.apiModel,
      instructions: this.instructions(),
      input: this.history,
      tools,
      tool_choice: "required",
      parallel_tool_calls: false,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(target.mode === "fast" ? { service_tier: "priority" } : {}),
      ...(gpt56
        ? {
            text: { verbosity: "low" },
            prompt_cache_key: this.sessionId,
          }
        : {}),
      ...(reasoning ? { reasoning } : {}),
    };
    this.trace("request", {
      step,
      transport: auth.type,
      url: auth.url,
      model: body.model,
      inputItems: this.history.length,
      latestInput: this.history.at(-1),
      tools: tools.map((tool) => tool.name),
      reasoning: body.reasoning,
      systemPrompt: body.instructions,
    });
    const response = await fetch(auth.url, {
      method: "POST",
      headers: {
        ...auth.headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        originator: "opencode",
        "User-Agent": "Logos/1.3.0",
        "session-id": this.sessionId,
      },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });
    this.trace("response", { step, status: response.status, ok: response.ok });
    if (!response.ok) {
      const detail = byteLimit(await response.text(), 16 * 1024);
      throw new Error(`OpenAI Responses API failed (${response.status}): ${detail}`);
    }
    if (!response.body) throw new Error("OpenAI returned an empty response stream");

    const output = new Map<string, InputItem>();
    let completedOutput: InputItem[] | undefined;
    let responseId: string | undefined;
    let usage: unknown;
    let text = "";
    let sawTextDelta = false;
    let completedStream = false;
    const decoder = new TextDecoder();
    let buffer = "";
    const processFrame = (rawFrame: string) => {
      const frame = rawFrame.replaceAll("\r", "");
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        this.trace("protocol-error", { frame: frame.slice(0, 1000) });
        return;
      }
      const type = String(event.type ?? "event");
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        sawTextDelta = true;
        text += event.delta;
        this.hooks.emit({
          kind: "text-delta",
          sessionId: this.request.sessionId,
          messageId,
          delta: event.delta,
        });
      } else if (
        (type === "response.reasoning_summary_text.delta" ||
          type === "response.reasoning_text.delta") &&
        typeof event.delta === "string"
      ) {
        this.hooks.emit({
          kind: "thinking",
          sessionId: this.request.sessionId,
          messageId,
          delta: event.delta,
        });
      } else if (
        (type === "response.output_item.added" || type === "response.output_item.done") &&
        event.item &&
        typeof event.item === "object"
      ) {
        const item = event.item as InputItem;
        const key = String(item.id ?? event.output_index ?? output.size);
        output.set(key, item);
        if (type.endsWith(".done")) this.trace("output-item", item);
      } else if (
        (type === "response.function_call_arguments.delta" ||
          type === "response.function_call_arguments.done") &&
        (typeof event.item_id === "string" || typeof event.output_index === "number")
      ) {
        const key = String(event.item_id ?? event.output_index);
        const item = output.get(key);
        if (item?.type === "function_call") {
          const value =
            type.endsWith(".done") && typeof event.arguments === "string"
              ? event.arguments
              : `${typeof item.arguments === "string" ? item.arguments : ""}${typeof event.delta === "string" ? event.delta : ""}`;
          output.set(key, { ...item, arguments: value });
        }
      } else if (type === "response.completed") {
        const completed = event.response as
          | { id?: string; output?: InputItem[]; usage?: unknown }
          | undefined;
        completedStream = true;
        completedOutput = completed?.output;
        responseId = completed?.id;
        usage = completed?.usage;
        this.trace("completed", {
          responseId,
          usage,
          outputTypes: completedOutput?.map((item) => item.type),
        });
      } else if (
        type === "error" ||
        type === "response.error" ||
        type === "response.failed" ||
        type === "response.incomplete"
      ) {
        throw new Error(stringify(event.error ?? event.response ?? event));
      }
    };
    const drainFrames = () => {
      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) return;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        processFrame(frame);
      }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      drainFrames();
    }
    buffer += decoder.decode();
    drainFrames();
    if (buffer.trim()) processFrame(buffer);
    if (!completedStream) {
      throw new Error("OpenAI response stream ended before response.completed");
    }
    const items = mergeResponseOutput([...output.values()], completedOutput);
    if (!sawTextDelta) {
      text = items
        .flatMap((item) =>
          item.type === "message" && Array.isArray(item.content)
            ? (item.content as Array<Record<string, unknown>>)
                .filter((part) => part.type === "output_text")
                .map((part) => String(part.text ?? ""))
            : [],
        )
        .join("");
      if (text) {
        this.hooks.emit({
          kind: "text",
          sessionId: this.request.sessionId,
          messageId,
          text,
        });
      }
    }
    const callsById = new Map<string, FunctionCall>();
    items.forEach((item) => {
      const call = normalizeFunctionCall(item);
      if (!call && item.type === "function_call") {
        this.trace("rejected-tool-call", item);
      }
      if (call) callsById.set(call.call_id, call);
    });
    const calls = [...callsById.values()];
    const normalizedItems = items.flatMap((item) => {
      if (item.type !== "function_call") return replayableOutput(item) ? [item] : [];
      const call = normalizeFunctionCall(item);
      return call ? [call] : [];
    });
    this.trace("recognized-tools", { count: calls.length, names: calls.map((call) => call.name) });
    return {
      output: normalizedItems,
      calls,
      text,
      usage,
      responseId,
    };
  }

  private async executeCall(call: FunctionCall): Promise<ToolResult> {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      input = {};
    }
    const locations = typeof input.path === "string" ? [{ path: input.path }] : undefined;
    this.hooks.emit({
      kind: "tool-use",
      sessionId: this.request.sessionId,
      toolUseId: call.call_id,
      name: call.name,
      input,
      status: "in_progress",
      locations,
    });
    this.trace("tool-call", { callId: call.call_id, name: call.name, input });
    let result: ToolResult;
    try {
      if (!(await this.mayRun(call.name, input))) {
        result = { output: "Denied by user", isError: true };
      } else {
        result = await this.runTool(call.name, input);
      }
    } catch (error) {
      result = {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
    result.output = byteLimit(result.output);
    this.trace("tool-result", {
      callId: call.call_id,
      name: call.name,
      isError: Boolean(result.isError),
      output: result.output,
    });
    this.hooks.emit({
      kind: "tool-result",
      sessionId: this.request.sessionId,
      toolUseId: call.call_id,
      isError: Boolean(result.isError),
      content: result.output,
      locations: result.locations,
      diffs: result.diffs,
    });
    if (result.locations?.[0]) {
      this.hooks.emit({
        kind: "follow",
        sessionId: this.request.sessionId,
        location: result.locations[0],
      });
    }
    return result;
  }

  private async runTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case "Read": {
        const target = await this.workspacePath(String(input.path ?? ""), true);
        const source = await this.readVerifiedFile(target, MAX_FILE_BYTES);
        const lines = source.content.split("\n");
        const start = Math.max(Number(input.start_line ?? 1) - 1, 0);
        const limit = Math.min(Math.max(Number(input.limit ?? 400), 1), 4000);
        return {
          output: lines
            .slice(start, start + limit)
            .map((line, index) => `${start + index + 1}: ${line}`)
            .join("\n"),
          locations: [{ path: target, line: start + 1 }],
        };
      }
      case "Glob": {
        const target = await this.workspacePath(String(input.path ?? "."), true);
        const entries = await fs.readdir(target, { withFileTypes: true });
        return {
          output: entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 500)
            .map((entry) => `${entry.isDirectory() ? "dir " : "file"}\t${entry.name}`)
            .join("\n"),
          locations: [{ path: target }],
        };
      }
      case "Grep":
        return this.searchFiles(
          String(input.pattern ?? ""),
          String(input.path ?? "."),
          Boolean(input.case_sensitive),
          typeof input.include === "string" ? input.include : undefined,
        );
      case "Write": {
        let target = await this.workspacePath(String(input.path ?? ""), false);
        const content = String(input.content ?? "");
        if (Buffer.byteLength(content) > 5 * MAX_FILE_BYTES) {
          throw new Error("File exceeds the 5 MiB write limit");
        }
        let oldText = "";
        let existingMode: number | undefined;
        try {
          const existing = await this.readVerifiedFile(target, 5 * MAX_FILE_BYTES);
          oldText = existing.content;
          existingMode = existing.mode;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const realParent = await fs.realpath(path.dirname(target)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("Write requires the parent directory to exist");
          }
          throw error;
        });
        const parentRelative = path.relative(this.workspaceRoot, realParent);
        if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
          throw new Error(`Path resolves outside the workspace: ${String(input.path ?? "")}`);
        }
        target = path.join(realParent, path.basename(target));
        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          const handle = await fs.open(
            temp,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              (fsConstants.O_NOFOLLOW ?? 0),
            0o666,
          );
          try {
            await handle.writeFile(content, "utf8");
          } finally {
            await handle.close();
          }
          const realTemp = await fs.realpath(temp);
          const tempRelative = path.relative(this.workspaceRoot, realTemp);
          if (tempRelative.startsWith("..") || path.isAbsolute(tempRelative)) {
            throw new Error(`Path resolves outside the workspace: ${String(input.path ?? "")}`);
          }
          if (existingMode !== undefined) await fs.chmod(temp, existingMode);
          if ((await fs.realpath(realParent)) !== realParent) {
            throw new Error("Write parent changed while the agent was running");
          }
          await fs.rename(temp, target);
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
        return {
          output: `Wrote ${Buffer.byteLength(content)} bytes to ${target}`,
          locations: [{ path: target, line: 1 }],
          diffs:
            Buffer.byteLength(oldText) + Buffer.byteLength(content) <= MAX_FILE_BYTES
              ? [{ path: target, oldText, newText: content }]
              : undefined,
        };
      }
      case "Bash":
        return this.runBash(input);
      case "Skill":
        return this.runSkill(input);
      case "MCP":
        return this.mcp.run(
          input as McpToolInput,
          this.abortController?.signal,
          this.approvedMcpConfigs.get(input),
        );
      case "DAP_REPL":
        return this.runDapRepl(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async searchFiles(
    pattern: string,
    inputPath: string,
    caseSensitive: boolean,
    include?: string,
  ): Promise<ToolResult> {
    if (!pattern) throw new Error("Grep pattern is required");
    if (pattern.length > 2_000) throw new Error("Grep pattern exceeds 2,000 characters");
    const root = await this.workspacePath(inputPath, true);
    new RegExp(pattern, caseSensitive ? "" : "i");
    const includeMatcher = include ? this.globMatcher(include) : null;
    const matches = await new Promise<Array<{ path: string; line: number; text: string }>>(
      (resolve, reject) => {
        const worker = new Worker(GREP_WORKER_SOURCE, {
          eval: true,
          workerData: {
            root,
            workspaceRoot: this.workspaceRoot,
            pattern,
            caseSensitive,
            includeSource: includeMatcher?.source,
          },
        });
        this.activeSearchWorker = worker;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (this.activeSearchWorker === worker) this.activeSearchWorker = null;
          void worker.terminate();
          reject(new Error("Grep timed out after 5 seconds"));
        }, 5_000);
        const finish = () => {
          clearTimeout(timer);
          if (this.activeSearchWorker === worker) this.activeSearchWorker = null;
        };
        worker.once("message", (value: unknown) => {
          if (settled) return;
          settled = true;
          finish();
          resolve(
            Array.isArray(value)
              ? value.filter(
                  (item): item is { path: string; line: number; text: string } =>
                    Boolean(item) &&
                    typeof item === "object" &&
                    typeof item.path === "string" &&
                    Number.isInteger(item.line) &&
                    typeof item.text === "string",
                )
              : [],
          );
        });
        worker.once("error", (error) => {
          if (settled) return;
          settled = true;
          finish();
          reject(error);
        });
        worker.once("exit", (code) => {
          if (settled) return;
          settled = true;
          finish();
          reject(new Error(`Grep worker exited with code ${code}`));
        });
      },
    );
    const first = matches[0];
    return {
      output: matches.length
        ? matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n")
        : "No matches",
      ...(first
        ? {
            locations: [
              {
                path: await this.workspacePath(first.path, true),
                line: first.line,
              },
            ],
          }
        : {}),
    };
  }

  private async runBash(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input.command ?? "").trim();
    if (!command) throw new Error("Command is required");
    const cwd = await this.workspacePath(String(input.cwd ?? "."), true);
    const timeoutMs = Math.min(Math.max(Number(input.timeout_ms ?? 30_000), 1000), 120_000);
    const executable = process.platform === "win32" ? "bash.exe" : "/bin/bash";
    const args = ["--noprofile", "--norc", "-c", command];
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(executable, args, {
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.activeToolProcess = child;
      let output = "";
      const append = (chunk: Buffer) => {
        output = byteLimit(output + chunk.toString("utf8"));
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => stopProcessTree(child), timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        if (this.activeToolProcess === child) this.activeToolProcess = null;
        resolve({
          output: commandOutput(
            output,
            `spawn error: ${byteLimit(error.message, 1024)}`,
          ),
          isError: true,
        });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (this.activeToolProcess === child) this.activeToolProcess = null;
        resolve({
          output: commandOutput(
            output,
            `exit ${signal ?? code ?? "unknown"}`,
          ),
          isError: code !== 0,
        });
      });
    });
  }

  private globMatcher(pattern: string): RegExp {
    let source = "";
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index];
      if (character === "*") {
        if (pattern[index + 1] === "*") {
          if (pattern[index + 2] === "/") {
            source += "(?:.*/)?";
            index += 2;
          } else {
            source += ".*";
            index++;
          }
        } else source += "[^/]*";
      } else if (character === "?") source += "[^/]";
      else source += "\\^$+.|()[]{}".includes(character) ? `\\${character}` : character;
    }
    return new RegExp(`^${source}$`);
  }

  private async runSkill(input: Record<string, unknown>): Promise<ToolResult> {
    const skills = await this.discoverSkills();
    const name = String(input.name ?? "").trim();
    if (!name) {
      return {
        output: skills.length
          ? skills.map((skill) => `${skill.name}\t${skill.source}`).join("\n")
          : "No skills found",
      };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error("Skill name is invalid");
    }
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Skill '${name}' was not found`);
    const requested = String(input.path ?? "SKILL.md");
    const target = await fs.realpath(path.resolve(skill.directory, requested));
    const relative = path.relative(skill.directory, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Skill path is outside '${name}': ${requested}`);
    }
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Skill path is not a file: ${requested}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error("Skill file exceeds the 1 MiB limit");
    return { output: await fs.readFile(target, "utf8") };
  }

  private async discoverSkills(): Promise<
    Array<{ name: string; source: "project" | "user"; directory: string }>
  > {
    const roots: Array<{ source: "project" | "user"; directory: string }> = [];
    if (this.request.settingSources?.includes("project")) {
      roots.push(
        { source: "project", directory: path.join(this.workspaceRoot, ".agents", "skills") },
        { source: "project", directory: path.join(this.workspaceRoot, ".claude", "skills") },
        { source: "project", directory: path.join(this.workspaceRoot, ".logos", "skills") },
      );
    }
    if (this.request.settingSources?.includes("user")) {
      roots.push(
        { source: "user", directory: path.join(os.homedir(), ".agents", "skills") },
        { source: "user", directory: path.join(os.homedir(), ".claude", "skills") },
      );
    }
    const result: Array<{
      name: string;
      source: "project" | "user";
      directory: string;
    }> = [];
    for (const root of roots) {
      let realRoot: string;
      try {
        realRoot = await fs.realpath(root.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (root.source === "project") {
        const relative = path.relative(this.workspaceRoot, realRoot);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      }
      const entries = await fs.readdir(realRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const directory = await fs.realpath(path.join(realRoot, entry.name)).catch(() => "");
        if (!directory) continue;
        const relative = path.relative(realRoot, directory);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const skillFile = path.join(directory, "SKILL.md");
        const exists = await fs.stat(skillFile).then((stat) => stat.isFile()).catch(() => false);
        if (exists && !result.some((skill) => skill.name === entry.name)) {
          result.push({ name: entry.name, source: root.source, directory });
        }
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async runDapRepl(input: Record<string, unknown>): Promise<ToolResult> {
    const expression = String(input.expression ?? "").trim();
    if (!expression) throw new Error("DAP expression is required");
    const session = this.resolveDebugSession(input);
    const approvedGeneration = this.approvedDapGenerations.get(input);
    if (
      !approvedGeneration ||
      this.hooks.debug!.generation(session.id) !== approvedGeneration
    ) {
      throw new Error("The debug session changed after approval; review and approve it again");
    }
    const response = await this.hooks.debug!.request<DapEvaluateResult>(
      session.id,
      "evaluate",
      {
        expression,
        context: "repl",
        ...(Number.isInteger(input.frame_id) ? { frameId: input.frame_id } : {}),
      },
    );
    if (!response.success) throw new Error(response.message ?? "DAP evaluation failed");
    return { output: JSON.stringify(response.body ?? {}, null, 2) };
  }

  private resolveDebugSession(input: Record<string, unknown>): DebugSessionInfo {
    if (!this.hooks.debug) throw new Error("The debug service is unavailable");
    const active = this.hooks.debug
      .list()
      .filter(
        (session) =>
          session.status !== "terminated" &&
          session.status !== "terminating" &&
          session.status !== "error",
      );
    const requestedId = String(input.session_id ?? "").trim();
    const session = requestedId
      ? active.find((candidate) => candidate.id === requestedId)
      : active.length === 1
        ? active[0]
        : undefined;
    if (!session) {
      const available = active.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ");
      throw new Error(
        requestedId
          ? `Debug session '${requestedId}' is not active${available ? `; available: ${available}` : ""}`
          : active.length === 0
            ? "No active debug session"
            : `Multiple debug sessions are active; choose session_id: ${available}`,
      );
    }
    return session;
  }

  private async workspacePath(input: string, mustExist: boolean): Promise<string> {
    const root = this.workspaceRoot;
    const currentRoot = await fs.realpath(root).catch(() => "");
    if (currentRoot !== root) {
      throw new Error("The workspace root changed while the agent was running");
    }
    const target = path.resolve(root, input || ".");
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the workspace: ${input}`);
    }
    if (mustExist) {
      const real = await fs.realpath(target);
      const realRelative = path.relative(root, real);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`Path resolves outside the workspace: ${input}`);
      }
      return real;
    }
    try {
      const real = await fs.realpath(target);
      const realRelative = path.relative(root, real);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`Path resolves outside the workspace: ${input}`);
      }
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let existing = path.dirname(target);
    while (existing !== root) {
      try {
        const realParent = await fs.realpath(existing);
        const parentRelative = path.relative(root, realParent);
        if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
          throw new Error(`Path resolves outside the workspace: ${input}`);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existing = path.dirname(existing);
      }
    }
    return target;
  }

  private async readVerifiedFile(
    target: string,
    maxBytes: number,
  ): Promise<{ content: string; mode: number }> {
    const handle = await fs.open(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const [handleStat, real] = await Promise.all([
        handle.stat(),
        fs.realpath(target),
      ]);
      const relative = path.relative(this.workspaceRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Path resolves outside the workspace: ${target}`);
      }
      const pathStat = await fs.stat(real);
      if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
        throw new Error("File changed while the agent was opening it");
      }
      if (!handleStat.isFile()) throw new Error(`Path is not a file: ${target}`);
      if (handleStat.size > maxBytes) {
        throw new Error(`File exceeds the ${maxBytes / MAX_FILE_BYTES} MiB read limit`);
      }
      return {
        content: await handle.readFile("utf8"),
        mode: handleStat.mode & 0o7777,
      };
    } finally {
      await handle.close();
    }
  }

  private async mayRun(name: string, input: unknown): Promise<boolean> {
    if (this.disallowedTools.includes(name)) return false;
    const planBlocked =
      name === "Write" || name === "Bash" || name === "MCP" || name === "DAP_REPL";
    if (this.mode === "plan" && planBlocked) return false;
    if (name === "Bash") {
      return this.hooks.requestPermission(
        this.request.sessionId,
        name,
        input,
        HIGH_RISK_PERMISSION_OPTIONS,
      );
    }
    if (name === "DAP_REPL") {
      const dapInput = input as Record<string, unknown>;
      const session = this.resolveDebugSession(dapInput);
      const generation = this.hooks.debug?.generation(session.id);
      if (!generation) throw new Error(`Debug session '${session.id}' is not active`);
      dapInput.session_id = session.id;
      const allowed = await this.hooks.requestPermission(
        this.request.sessionId,
        name,
        {
          ...dapInput,
          session: {
            id: session.id,
            name: session.name,
            type: session.debugType,
            status: session.status,
          },
        },
        HIGH_RISK_PERMISSION_OPTIONS,
      );
      if (allowed) this.approvedDapGenerations.set(dapInput, generation);
      return allowed;
    }
    if (name === "MCP" && (input as McpToolInput).action !== "list_servers") {
      const approval = await this.mcp.permissionDetails(input as McpToolInput);
      const allowed = await this.hooks.requestPermission(
        this.request.sessionId,
        name,
        approval.details,
        HIGH_RISK_PERMISSION_OPTIONS,
      );
      if (allowed && approval.fingerprint && input && typeof input === "object") {
        this.approvedMcpConfigs.set(input, approval.fingerprint);
      }
      return allowed;
    }
    if (name !== "Write") return true;
    if (this.mode === "bypassPermissions") return true;
    if (this.allowedTools.includes(name)) return true;
    if (this.mode === "acceptEdits") return true;
    return this.hooks.requestPermission(this.request.sessionId, name, input);
  }

  private instructions(): string {
    return buildLogosAgentSystemPrompt({
      workspace: this.workspaceRoot,
      mode: this.mode,
    });
  }

  private async emitReady(): Promise<void> {
    const status = await this.auth.status();
    const modelAuthType = status.type === "api-key" ? "api-key" : "chatgpt";
    if (status.type === "chatgpt") {
      try {
        resolveLogosOpenAIModel(this.model, modelAuthType);
      } catch {
        this.model = DEFAULT_LOGOS_MODEL;
      }
    }
    this.hooks.emit({
      kind: "runtime-ready",
      sessionId: this.request.sessionId,
      runtimeName: status.type === "none" ? "Logos" : `Logos · ${status.label ?? status.type}`,
      sdkSessionId: this.sessionId,
      modes: [
        { id: "default", name: "Build" },
        { id: "plan", name: "Plan" },
        { id: "acceptEdits", name: "Accept edits" },
        { id: "bypassPermissions", name: "Bypass permissions" },
      ],
      currentModeId: this.mode,
      models: logosOpenAIModels(modelAuthType),
      currentModelId: this.model,
      configOptions: [],
      commands: [],
      authMethods: AUTH_METHODS,
      canConfigureProviders: false,
    });
  }

  private trace(subtype: string, data: unknown): void {
    if (this.disposed) return;
    this.hooks.emit({
      kind: "system",
      sessionId: this.request.sessionId,
      subtype: `logos-${subtype}`,
      data,
    });
  }

  private async restore(): Promise<void> {
    if (!this.request.resume) return;
    try {
      const file = this.sessionFile();
      const stat = await fs.stat(file);
      if (stat.size > 10 * MAX_FILE_BYTES) throw new Error("Saved agent session is too large");
      const raw = await fs.readFile(file, "utf8");
      const value = JSON.parse(raw) as {
        cwd?: string;
        history?: InputItem[];
        model?: string;
        mode?: AgentPermissionMode;
      };
      if (value.cwd !== this.workspaceRoot) {
        throw new Error("Saved agent session belongs to a different workspace");
      }
      this.history = Array.isArray(value.history) ? value.history.slice(-2000) : [];
      this.model = this.request.model || value.model || this.model;
      this.mode = value.mode ?? this.mode;
      this.trace("session-restored", { items: this.history.length });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    if (this.history.length === 0) {
      await fs.rm(this.sessionFile(), { force: true });
      return;
    }
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const file = this.sessionFile();
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(
      temp,
      JSON.stringify({
        cwd: this.workspaceRoot,
        history: this.history,
        model: this.model,
        mode: this.mode,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temp, file);
  }

  private sessionFile(): string {
    return path.join(this.sessionsDir, `${this.sessionId}.json`);
  }
}
