import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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

const MAX_STEPS = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

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
  ): Promise<boolean>;
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

const TOOLS = [
  {
    type: "function",
    name: "read_file",
    description: LOGOS_AGENT_TOOLS[0].description,
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
    name: "list_directory",
    description: LOGOS_AGENT_TOOLS[1].description,
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
    name: "search",
    description: LOGOS_AGENT_TOOLS[2].description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        case_sensitive: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: LOGOS_AGENT_TOOLS[3].description,
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
    name: "run_command",
    description: LOGOS_AGENT_TOOLS[4].description,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
      },
      required: ["command"],
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
  return `${buffer.subarray(0, max).toString("utf8")}\n...[truncated]`;
}

function isFunctionCall(item: InputItem): item is FunctionCall {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string" &&
    typeof item.call_id === "string"
  );
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
  private abortController: AbortController | null = null;
  private activeToolProcess: ChildProcess | null = null;
  private pendingPrompts: string[] = [];
  private running = false;
  private disposed = false;

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
          await this.persist();
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
        for (const call of result.calls) {
          const toolResult = await this.executeCall(call);
          this.history.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: toolResult.output,
          });
        }
        await this.persist();
      }
      throw new Error(`Agent stopped after ${MAX_STEPS} tool steps`);
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
    for (const prompt of pending) void this.prompt(prompt);
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
    if (this.activeToolProcess) stopProcessTree(this.activeToolProcess);
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

  async dispose(removeHistory = false): Promise<void> {
    this.disposed = true;
    this.abortController?.abort();
    if (this.activeToolProcess) stopProcessTree(this.activeToolProcess);
    if (removeHistory) await fs.rm(this.sessionFile(), { force: true });
    else await this.persist().catch(() => undefined);
  }

  private async requestTurn(step: number): Promise<ResponsesResult> {
    const auth = await this.auth.requestAuth(this.request.baseUrl || "https://api.openai.com/v1");
    const messageId = crypto.randomUUID();
    const tools = TOOLS.filter(
      (tool) =>
        !this.request.disallowedTools?.includes(tool.name) &&
        (this.mode !== "plan" ||
          (tool.name !== "write_file" && tool.name !== "run_command")),
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
      tool_choice: "auto",
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
    const items = completedOutput ?? [...output.values()];
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
    return {
      output: items.filter(replayableOutput),
      calls: items.filter(isFunctionCall),
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
      if (this.isMutating(call.name) && !(await this.mayRun(call.name, input))) {
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
      case "read_file": {
        const target = await this.workspacePath(String(input.path ?? ""), true);
        const stat = await fs.stat(target);
        if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB read limit");
        const lines = (await fs.readFile(target, "utf8")).split("\n");
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
      case "list_directory": {
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
      case "search":
        return this.searchFiles(
          String(input.query ?? ""),
          String(input.path ?? "."),
          Boolean(input.case_sensitive),
        );
      case "write_file": {
        const target = await this.workspacePath(String(input.path ?? ""), false);
        const content = String(input.content ?? "");
        if (Buffer.byteLength(content) > 5 * MAX_FILE_BYTES) {
          throw new Error("File exceeds the 5 MiB write limit");
        }
        const oldText = await fs.readFile(target, "utf8").catch(() => "");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return {
          output: `Wrote ${Buffer.byteLength(content)} bytes to ${target}`,
          locations: [{ path: target, line: 1 }],
          diffs: [{ path: target, oldText, newText: content }],
        };
      }
      case "run_command":
        return this.runCommand(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async searchFiles(
    query: string,
    inputPath: string,
    caseSensitive: boolean,
  ): Promise<ToolResult> {
    if (!query) throw new Error("Search query is required");
    const root = await this.workspacePath(inputPath, true);
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: string[] = [];
    const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", "release"]);
    const walk = async (current: string): Promise<void> => {
      if (matches.length >= 100) return;
      const stat = await fs.stat(current);
      if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) return;
        const source = await fs.readFile(current, "utf8").catch(() => "");
        if (source.includes("\0")) return;
        source.split("\n").forEach((line, index) => {
          if (matches.length >= 100) return;
          const value = caseSensitive ? line : line.toLowerCase();
          if (value.includes(needle)) {
            matches.push(`${path.relative(this.workspaceRoot, current)}:${index + 1}:${line}`);
          }
        });
        return;
      }
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= 100) break;
        if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
        await walk(path.join(current, entry.name));
      }
    };
    await walk(root);
    return { output: matches.length ? matches.join("\n") : "No matches" };
  }

  private async runCommand(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input.command ?? "").trim();
    if (!command) throw new Error("Command is required");
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const cwd = await this.workspacePath(String(input.cwd ?? "."), true);
    const timeoutMs = Math.min(Math.max(Number(input.timeout_ms ?? 30_000), 1000), 120_000);
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(command, args, {
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
        resolve({ output: `${output}${error.message}`, isError: true });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (this.activeToolProcess === child) this.activeToolProcess = null;
        resolve({
          output: `${output}\n[exit ${signal ?? code ?? "unknown"}]`.trim(),
          isError: code !== 0,
        });
      });
    });
  }

  private async workspacePath(input: string, mustExist: boolean): Promise<string> {
    const root = this.workspaceRoot;
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

  private isMutating(name: string): boolean {
    return name === "write_file" || name === "run_command";
  }

  private async mayRun(name: string, input: unknown): Promise<boolean> {
    if (this.mode === "bypassPermissions") return true;
    if (this.request.allowedTools?.includes(name)) return true;
    if (this.mode === "acceptEdits" && name === "write_file") return true;
    if (this.mode === "plan" || this.request.disallowedTools?.includes(name)) return false;
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
