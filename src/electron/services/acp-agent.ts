import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type {
  AgentAuthMethod,
  AgentAuthRequest,
  AgentAuthResult,
  AgentConfigOption,
  AgentEvent,
  AgentModelInfo,
  AgentPermissionOption,
  AgentProviderConfig,
  AgentProviderInfo,
  AgentQuestion,
  AgentSetConfigRequest,
  AgentSlashCommand,
  AgentStartRequest,
  AgentToolDiff,
  AgentToolLocation,
} from "../../shared/types";
import type {
  AgentCapabilities,
  AuthMethod,
  Client,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  InitializeResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import { augmentPath } from "./path-env";

type AcpSdk = typeof import("@agentclientprotocol/sdk");

const importAcp = new Function(
  "return import('@agentclientprotocol/sdk')",
) as () => Promise<AcpSdk>;

const ACP_SETUP_TIMEOUT_MS = 30_000;
const MAX_ACP_FILE_BYTES = 1024 * 1024;

async function readBoundedTextFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("ACP file read requires a regular file");
    if (stat.size > MAX_ACP_FILE_BYTES) {
      throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} byte limit`);
    }
    const buffer = Buffer.alloc(MAX_ACP_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_ACP_FILE_BYTES) {
      throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} byte limit`);
    }
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

async function withSetupTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${operation} timed out after 30 seconds`)),
          ACP_SETUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AcpAgentHooks {
  emit(event: AgentEvent): void;
  requestPermission(
    sessionId: string,
    toolName: string,
    input: unknown,
    options: AgentPermissionOption[],
  ): Promise<{ optionId?: string; cancelled?: boolean }>;
  requestAsk(
    sessionId: string,
    questions: AgentQuestion[],
  ): Promise<{
    action: "accept" | "cancel";
    answers: Record<string, string | string[] | number | boolean>;
  }>;
  closed(sessionId: string): void;
}

function augmentedEnv(
  extra: Record<string, string> = {},
  sanitizeInherited = false,
): NodeJS.ProcessEnv {
  const inherited = sanitizeInherited
    ? Object.fromEntries(
        [
          "HOME",
          "USERPROFILE",
          "TMPDIR",
          "TEMP",
          "TMP",
          "LANG",
          "LC_ALL",
          "SHELL",
          "COMSPEC",
          "SYSTEMROOT",
          "WINDIR",
        ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
      )
    : process.env;
  const env = {
    ...inherited,
    ...extra,
  };
  if (sanitizeInherited && !Object.keys(extra).some((key) => key.toLowerCase() === "path")) {
    env.PATH = process.env.PATH;
  }
  augmentPath(env);
  return env;
}

interface AcpTerminal {
  process: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
  exited: Promise<{ exitCode?: number | null; signal?: string | null }>;
}

interface SessionSetup {
  sessionId: string;
  modes?: NewSessionResponse["modes"];
  models?: NewSessionResponse["models"];
  configOptions?: SessionConfigOption[] | null;
}

export class AcpAgentRuntime {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly connection: import("@agentclientprotocol/sdk").ClientSideConnection;
  private readonly terminals = new Map<string, AcpTerminal>();
  private readonly authMethods: AgentAuthMethod[];
  private readonly capabilities: AgentCapabilities;
  private acpSessionId: string | null = null;
  private setup: SessionSetup | null = null;
  private currentMessageId = crypto.randomUUID();
  private readonly pendingPrompts: string[] = [];
  private promptQueue: Promise<void> = Promise.resolve();
  private authBlocked = false;
  private disposed = false;

  private constructor(
    private readonly request: AgentStartRequest,
    private readonly hooks: AcpAgentHooks,
    process: ChildProcessWithoutNullStreams,
    connection: import("@agentclientprotocol/sdk").ClientSideConnection,
    initialized: InitializeResponse,
  ) {
    this.process = process;
    this.connection = connection;
    this.capabilities = initialized.agentCapabilities ?? {};
    this.authMethods = normalizeAuthMethods(
      initialized.authMethods ?? [],
      request.runtime?.type === "acp" ? request.runtime.server : null,
    );
  }

  static async create(
    request: AgentStartRequest,
    hooks: AcpAgentHooks,
  ): Promise<AcpAgentRuntime> {
    if (request.runtime?.type !== "acp") {
      throw new Error("ACP runtime configuration is missing");
    }
    const server = request.runtime.server;
    request = { ...request, cwd: await fs.realpath(request.cwd) };
    const sdk = await importAcp();
    hooks.emit({
      kind: "system",
      sessionId: request.sessionId,
      subtype: "acp-launch",
      data: {
        command: server.command,
        args: server.args,
        cwd: request.cwd,
        envKeys: Object.keys(server.env),
      },
    });
    const child = spawn(server.command, server.args, {
      cwd: request.cwd,
      env: augmentedEnv(server.env, server.id.startsWith("registry:")),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const started = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await started;

    try {
      const runtimeRef: { current?: AcpAgentRuntime } = {};
      const client = createClient(request, hooks, runtimeRef);
      const stream = sdk.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const connection = new sdk.ClientSideConnection(() => client, stream);
      const initialized = await withSetupTimeout(
        connection.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientInfo: { name: "Logos", title: "Logos IDE", version: "1.3.0" },
          clientCapabilities: {
            _meta: { "terminal-auth": true },
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            auth: { terminal: true },
            elicitation: { form: {}, url: {} },
            positionEncodings: ["utf-16"],
          },
        }),
        "ACP initialization",
      );
      hooks.emit({
        kind: "system",
        sessionId: request.sessionId,
        subtype: "acp-initialize",
        data: initialized,
      });
      const runtime = new AcpAgentRuntime(
        request,
        hooks,
        child,
        connection,
        initialized,
      );
      runtimeRef.current = runtime;

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          hooks.emit({
            kind: "system",
            sessionId: request.sessionId,
            subtype: "acp-stderr",
            data: text,
          });
        }
      });
      child.once("exit", (code, signal) => {
        if (runtime.disposed) return;
        hooks.emit({
          kind: "error",
          sessionId: request.sessionId,
          message: `${server.name} exited (${signal ?? code ?? "unknown"})`,
        });
        hooks.closed(request.sessionId);
      });

      try {
        await runtime.ensureSession();
      } catch (error) {
        if (!isAuthError(error) || runtime.authMethods.length === 0) throw error;
        hooks.emit({
          kind: "auth-required",
          sessionId: request.sessionId,
          methods: runtime.authMethods,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return runtime;
    } catch (error) {
      child.removeAllListeners("exit");
      child.kill();
      throw error;
    }
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("ACP runtime is closed");
    if (!this.acpSessionId) {
      this.pendingPrompts.push(text);
      this.hooks.emit({
        kind: "auth-required",
        sessionId: this.request.sessionId,
        methods: this.authMethods,
      });
      return;
    }
    return this.enqueuePrompts([text]);
  }

  private enqueuePrompts(prompts: string[]): Promise<void> {
    const queued = this.promptQueue.then(async () => {
      for (const prompt of prompts) {
        if (this.authBlocked) this.pendingPrompts.push(prompt);
        else await this.runPrompt(prompt);
      }
    });
    this.promptQueue = queued.catch(() => undefined);
    return queued;
  }

  private async runPrompt(text: string): Promise<void> {
    if (this.disposed) return;
    if (!this.acpSessionId) {
      this.pendingPrompts.push(text);
      return;
    }
    const started = Date.now();
    this.currentMessageId = crypto.randomUUID();
    this.hooks.emit({
      kind: "system",
      sessionId: this.request.sessionId,
      subtype: "acp-prompt",
      data: { acpSessionId: this.acpSessionId, text },
    });
    try {
      const result = await this.connection.prompt({
        sessionId: this.acpSessionId,
        messageId: crypto.randomUUID(),
        prompt: [{ type: "text", text }],
      });
      if (this.disposed) return;
      this.hooks.emit({
        kind: "system",
        sessionId: this.request.sessionId,
        subtype: "acp-prompt-result",
        data: result,
      });
      this.hooks.emit({
        kind: "result",
        sessionId: this.request.sessionId,
        sdkSessionId: this.acpSessionId,
        isError: result.stopReason === "refusal",
        durationMs: Date.now() - started,
        costUsd: null,
        usage: result.usage ?? { stopReason: result.stopReason },
      });
    } catch (error) {
      if (this.disposed) return;
      if (isAuthError(error) && this.authMethods.length > 0) {
        this.authBlocked = true;
        this.pendingPrompts.push(text);
        this.hooks.emit({
          kind: "auth-required",
          sessionId: this.request.sessionId,
          methods: this.authMethods,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.hooks.emit({
        kind: "error",
        sessionId: this.request.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async interrupt(): Promise<void> {
    if (this.acpSessionId) {
      await this.connection.cancel({ sessionId: this.acpSessionId });
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.acpSessionId) return;
    await this.connection.setSessionMode({
      sessionId: this.acpSessionId,
      modeId,
    });
    if (this.setup?.modes) {
      this.setup = {
        ...this.setup,
        modes: { ...this.setup.modes, currentModeId: modeId },
      };
    }
    this.hooks.emit({ kind: "mode", sessionId: this.request.sessionId, modeId });
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.acpSessionId) return;
    await this.connection.unstable_setSessionModel({
      sessionId: this.acpSessionId,
      modelId,
    });
  }

  async setConfig(input: AgentSetConfigRequest): Promise<void> {
    if (!this.acpSessionId) return;
    const response = await this.connection.setSessionConfigOption({
      sessionId: this.acpSessionId,
      configId: input.configId,
      ...(typeof input.value === "boolean"
        ? { type: "boolean" as const, value: input.value }
        : { value: input.value }),
    });
    this.hooks.emit({
      kind: "config",
      sessionId: this.request.sessionId,
      options: normalizeConfigOptions(response.configOptions),
    });
  }

  async authenticate(input: AgentAuthRequest): Promise<AgentAuthResult> {
    const method = this.authMethods.find((item) => item.id === input.methodId);
    if (!method) throw new Error(`Unknown authentication method: ${input.methodId}`);
    if (method.terminal && !input.completed) {
      return {
        terminal: {
          cwd: this.request.cwd,
          executable: method.terminal.command,
          args: method.terminal.args,
          env: Object.fromEntries(
            Object.entries(method.terminal.env ?? {}).map(([key, value]) => [
              key,
              value,
            ]),
          ),
        },
      };
    }
    await this.connection.authenticate({ methodId: method.id });
    await this.ensureSession();
    this.authBlocked = false;
    const pending = this.pendingPrompts.splice(0);
    await this.enqueuePrompts(pending);
    return {};
  }

  async listProviders(): Promise<AgentProviderInfo[]> {
    if (!this.capabilities.providers) return [];
    const response = await this.connection.unstable_listProviders({});
    return response.providers.map((provider) => ({
      id: provider.id,
      required: provider.required,
      supported: provider.supported,
      ...(provider.current ? { current: provider.current } : {}),
    }));
  }

  async setProvider(config: AgentProviderConfig): Promise<void> {
    await this.connection.unstable_setProvider(config);
  }

  async disableProvider(providerId: string): Promise<void> {
    await this.connection.unstable_disableProvider({ id: providerId });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.authBlocked = true;
    this.pendingPrompts.length = 0;
    for (const terminal of this.terminals.values()) terminal.process.kill();
    this.terminals.clear();
    if (this.acpSessionId && this.capabilities.sessionCapabilities?.close) {
      await this.connection
        .closeSession({ sessionId: this.acpSessionId })
        .catch(() => undefined);
    }
    this.process.kill();
  }

  private async ensureSession(): Promise<void> {
    if (this.acpSessionId) return;
    let setup: SessionSetup;
    const common = { cwd: this.request.cwd, mcpServers: [] };
    if (this.request.resume && this.capabilities.sessionCapabilities?.resume) {
      const resumed: ResumeSessionResponse = await withSetupTimeout(
        this.connection.resumeSession({
          ...common,
          sessionId: this.request.resume,
        }),
        "ACP session resume",
      );
      setup = { ...resumed, sessionId: this.request.resume };
    } else if (this.request.resume && this.capabilities.loadSession) {
      const loaded = await withSetupTimeout(
        this.connection.loadSession({
          ...common,
          sessionId: this.request.resume,
        }),
        "ACP session load",
      );
      setup = { ...loaded, sessionId: this.request.resume };
    } else {
      setup = await withSetupTimeout(
        this.connection.newSession(common),
        "ACP session creation",
      );
    }
    this.setup = setup;
    this.acpSessionId = setup.sessionId;
    this.hooks.emit({
      kind: "system",
      sessionId: this.request.sessionId,
      subtype: "acp-session-ready",
      data: setup,
    });
    this.emitReady();
  }

  private emitReady(): void {
    if (!this.setup || !this.acpSessionId) return;
    const server =
      this.request.runtime?.type === "acp" ? this.request.runtime.server : null;
    this.hooks.emit({
      kind: "runtime-ready",
      sessionId: this.request.sessionId,
      runtimeName: server?.name ?? "ACP Agent",
      sdkSessionId: this.acpSessionId,
      modes: (this.setup.modes?.availableModes ?? []).map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
      currentModeId: this.setup.modes?.currentModeId,
      models: normalizeModels(this.setup.models?.availableModels ?? []),
      currentModelId: this.setup.models?.currentModelId,
      configOptions: normalizeConfigOptions(this.setup.configOptions ?? []),
      commands: [],
      authMethods: this.authMethods,
      canConfigureProviders: Boolean(this.capabilities.providers),
    });
  }

  async handleUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    const localSessionId = this.request.sessionId;
    this.hooks.emit({
      kind: "system",
      sessionId: localSessionId,
      subtype: "acp-session-update",
      data: update,
    });
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.hooks.emit({
            kind: "text-delta",
            sessionId: localSessionId,
            messageId: update.messageId ?? this.currentMessageId,
            delta: update.content.text,
          });
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.hooks.emit({
            kind: "thinking",
            sessionId: localSessionId,
            messageId: update.messageId ?? this.currentMessageId,
            delta: update.content.text,
          });
        }
        break;
      case "tool_call": {
        const payload = toolContent(update.content);
        const locations = normalizeLocations(update.locations);
        this.hooks.emit({
          kind: "tool-use",
          sessionId: localSessionId,
          toolUseId: update.toolCallId,
          name: update.title,
          input: update.rawInput,
          status: update.status,
          toolKind: update.kind,
          locations,
          ...payload,
        });
        this.follow(locations);
        break;
      }
      case "tool_call_update": {
        const payload = toolContent(update.content ?? undefined);
        const locations = normalizeLocations(update.locations ?? undefined);
        this.hooks.emit({
          kind: "tool-update",
          sessionId: localSessionId,
          toolUseId: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? undefined,
          input: update.rawInput,
          output: update.rawOutput,
          locations,
          ...payload,
        });
        this.follow(locations);
        break;
      }
      case "plan":
        this.hooks.emit({
          kind: "plan",
          sessionId: localSessionId,
          entries: update.entries.map((entry) => ({
            content: entry.content,
            status: entry.status,
            priority: entry.priority,
          })),
        });
        break;
      case "available_commands_update":
        this.hooks.emit({
          kind: "runtime-ready",
          sessionId: localSessionId,
          runtimeName:
            this.request.runtime?.type === "acp"
              ? this.request.runtime.server.name
              : "ACP Agent",
          sdkSessionId: this.acpSessionId ?? "",
          modes: (this.setup?.modes?.availableModes ?? []).map((mode) => ({
            id: mode.id,
            name: mode.name,
            ...(mode.description ? { description: mode.description } : {}),
          })),
          currentModeId: this.setup?.modes?.currentModeId,
          models: normalizeModels(this.setup?.models?.availableModels ?? []),
          currentModelId: this.setup?.models?.currentModelId,
          configOptions: normalizeConfigOptions(this.setup?.configOptions ?? []),
          commands: update.availableCommands.map(
            (command): AgentSlashCommand => ({
              name: command.name,
              description: command.description,
              argumentHint: command.input ? "[input]" : "",
            }),
          ),
          authMethods: this.authMethods,
          canConfigureProviders: Boolean(this.capabilities.providers),
        });
        break;
      case "current_mode_update":
        if (this.setup?.modes) {
          this.setup = {
            ...this.setup,
            modes: {
              ...this.setup.modes,
              currentModeId: update.currentModeId,
            },
          };
        }
        this.hooks.emit({
          kind: "mode",
          sessionId: localSessionId,
          modeId: update.currentModeId,
        });
        break;
      case "config_option_update":
        this.setup = this.setup
          ? { ...this.setup, configOptions: update.configOptions }
          : this.setup;
        this.hooks.emit({
          kind: "config",
          sessionId: localSessionId,
          options: normalizeConfigOptions(update.configOptions),
        });
        break;
      case "session_info_update":
        this.hooks.emit({
          kind: "session-info",
          sessionId: localSessionId,
          title: update.title ?? undefined,
        });
        break;
      default:
        break;
    }
  }

  async createTerminal(input: CreateTerminalRequest): Promise<{ terminalId: string }> {
    const cwd = await resolveWorkspacePath(
      this.request.cwd,
      input.cwd ?? this.request.cwd,
      true,
    );
    const env = Object.fromEntries(
      (input.env ?? []).map((entry) => [entry.name, entry.value]),
    );
    const child = spawn(input.command, input.args ?? [], {
      cwd,
      env: augmentedEnv(
        env,
        this.request.runtime?.type === "acp" &&
          this.request.runtime.server.id.startsWith("registry:"),
      ),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminalId = crypto.randomUUID();
    let finish!: (status: {
      exitCode?: number | null;
      signal?: string | null;
    }) => void;
    const terminal: AcpTerminal = {
      process: child,
      output: "",
      truncated: false,
      outputByteLimit: input.outputByteLimit ?? 1024 * 1024,
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
    };
    const append = (chunk: Buffer) => {
      terminal.output += chunk.toString("utf8");
      const bytes = Buffer.byteLength(terminal.output);
      if (bytes > terminal.outputByteLimit) {
        terminal.truncated = true;
        terminal.output = Buffer.from(terminal.output)
          .subarray(bytes - terminal.outputByteLimit)
          .toString("utf8")
          .replace(/^\uFFFD/, "");
      }
    };
    let settled = false;
    const complete = (exitCode?: number | null, signal?: string | null) => {
      if (settled) return;
      settled = true;
      terminal.exitStatus = { exitCode, signal };
      finish(terminal.exitStatus);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      append(Buffer.from(`${error.message}\n`));
      complete(null, "spawn_error");
    });
    child.once("close", (exitCode, signal) => complete(exitCode, signal));
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  terminalOutput(terminalId: string) {
    const terminal = this.requireTerminal(terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus,
    };
  }

  async waitForTerminal(terminalId: string) {
    return this.requireTerminal(terminalId).exited;
  }

  releaseTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    if (!terminal.exitStatus) terminal.process.kill();
    this.terminals.delete(terminalId);
  }

  killTerminal(terminalId: string): void {
    this.requireTerminal(terminalId).process.kill();
  }

  private requireTerminal(terminalId: string): AcpTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown ACP terminal: ${terminalId}`);
    return terminal;
  }

  private follow(locations?: AgentToolLocation[] | null): void {
    const location = locations?.[0];
    if (location) {
      this.hooks.emit({
        kind: "follow",
        sessionId: this.request.sessionId,
        location,
      });
    }
  }
}

function createClient(
  request: AgentStartRequest,
  hooks: AcpAgentHooks,
  runtimeRef: { current?: AcpAgentRuntime },
): Client {
  const runtime = () => {
    if (!runtimeRef.current) throw new Error("ACP runtime is not initialized");
    return runtimeRef.current;
  };
  return {
    sessionUpdate: (notification) => runtime().handleUpdate(notification),
    async requestPermission(input: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const options = input.options.map((option) => ({
        id: option.optionId,
        name: option.name,
        kind: option.kind,
      }));
      const response = await hooks.requestPermission(
        request.sessionId,
        input.toolCall.title ?? "Tool",
        input.toolCall.rawInput,
        options,
      );
      return response.cancelled || !response.optionId
        ? { outcome: { outcome: "cancelled" } }
        : {
            outcome: {
              outcome: "selected",
              optionId: response.optionId,
            },
          };
    },
    async readTextFile(input) {
      const filePath = await resolveWorkspacePath(request.cwd, input.path, true);
      const source = await readBoundedTextFile(filePath);
      const lines = source.split("\n");
      const start = Math.max((input.line ?? 1) - 1, 0);
      return {
        content: lines.slice(start, input.limit ? start + input.limit : undefined).join("\n"),
      };
    },
    async writeTextFile(input) {
      await writeWorkspaceTextFile(request.cwd, input.path, input.content);
      return {};
    },
    createTerminal: (input) => runtime().createTerminal(input),
    terminalOutput: (input) =>
      Promise.resolve(runtime().terminalOutput(input.terminalId)),
    waitForTerminalExit: (input) => runtime().waitForTerminal(input.terminalId),
    releaseTerminal: async (input) => {
      runtime().releaseTerminal(input.terminalId);
      return {};
    },
    killTerminal: async (input) => {
      runtime().killTerminal(input.terminalId);
      return {};
    },
    unstable_createElicitation: (input) => handleElicitation(request, hooks, input),
  };
}

async function handleElicitation(
  request: AgentStartRequest,
  hooks: AcpAgentHooks,
  input: CreateElicitationRequest,
): Promise<CreateElicitationResponse> {
  if (input.mode === "url") {
    const response = await hooks.requestAsk(request.sessionId, [
      {
        id: "url",
        header: "Continue in browser",
        question: input.message,
        options: [],
        multiSelect: false,
        type: "url",
        required: false,
        url: input.url,
      },
    ]);
    return response.action === "cancel" ? { action: "cancel" } : { action: "accept" };
  }
  const required = new Set(input.requestedSchema.required ?? []);
  const questions = Object.entries(input.requestedSchema.properties ?? {}).map(
    ([id, schema]): AgentQuestion => {
      const raw = schema as Record<string, unknown>;
      const oneOf = Array.isArray(raw.oneOf)
        ? (raw.oneOf as Array<{ const: string; title: string }>)
        : [];
      const enumValues = Array.isArray(raw.enum) ? (raw.enum as string[]) : [];
      const item = raw.items as
        | { enum?: string[]; anyOf?: Array<{ const: string; title: string }> }
        | undefined;
      const options = [
        ...oneOf.map((entry) => ({
          label: entry.title,
          description: entry.const,
          value: entry.const,
        })),
        ...enumValues.map((entry) => ({ label: entry, description: "" })),
        ...(item?.anyOf ?? []).map((entry) => ({
          label: entry.title,
          description: entry.const,
          value: entry.const,
        })),
        ...(item?.enum ?? []).map((entry) => ({
          label: entry,
          description: "",
        })),
      ];
      const type =
        schema.type === "array"
          ? "select"
          : schema.type === "boolean"
            ? "boolean"
            : schema.type === "number" || schema.type === "integer"
              ? "number"
              : options.length
                ? "select"
                : "text";
      return {
        id,
        header: schema.title ?? id,
        question: schema.description ?? input.message,
        options,
        multiSelect: schema.type === "array",
        type,
        required: required.has(id),
        defaultValue: schema.default ?? undefined,
        allowCustom: options.length === 0,
      };
    },
  );
  const response = await hooks.requestAsk(request.sessionId, questions);
  return response.action === "cancel"
    ? { action: "cancel" }
    : { action: "accept", content: response.answers };
}

function normalizeAuthMethods(
  methods: AuthMethod[],
  server: import("../../shared/types").AcpAgentConfig | null,
): AgentAuthMethod[] {
  return methods.map((method) => {
    const type = "type" in method ? method.type : "agent";
    const metaTerminal = (
      method._meta?.["terminal-auth"] as
        | { command?: string; args?: string[]; label?: string; env?: Record<string, string> }
        | undefined
    );
    if (type === "terminal" || metaTerminal) {
      const terminalMethod =
        type === "terminal"
          ? (method as Extract<AuthMethod, { type: "terminal" }>)
          : undefined;
      const registryManaged = server?.id.startsWith("registry:") === true;
      const authArgs = metaTerminal?.args ?? terminalMethod?.args ?? [];
      return {
        id: method.id,
        name: metaTerminal?.label ?? method.name,
        description: method.description ?? undefined,
        type: "terminal",
        terminal: {
          command:
            registryManaged
              ? server!.command
              : metaTerminal?.command ?? server?.command ?? "",
          args: registryManaged
            ? [...(server!.authArgsPrefix ?? []), ...authArgs]
            : authArgs,
          env:
            metaTerminal?.env ?? terminalMethod?.env,
        },
      };
    }
    if (type === "env_var") {
      const envMethod = method as Extract<AuthMethod, { type: "env_var" }>;
      return {
        id: method.id,
        name: method.name,
        description: method.description ?? undefined,
        type: "env_var",
        variables: envMethod.vars.map((variable) => ({
          name: variable.name,
          label: variable.label ?? undefined,
          secret: variable.secret !== false,
          optional: variable.optional === true,
        })),
      };
    }
    return {
      id: method.id,
      name: method.name,
      description: method.description ?? undefined,
      type: "agent",
    };
  });
}

function normalizeModels(
  models: Array<{ modelId: string; name: string; description?: string | null }>,
): AgentModelInfo[] {
  return models.map((model) => ({
    value: model.modelId,
    displayName: model.name,
    description: model.description ?? "",
  }));
}

function normalizeConfigOptions(options: SessionConfigOption[]): AgentConfigOption[] {
  return options.map((option) => {
    const common = {
      id: option.id,
      name: option.name,
      description: option.description ?? undefined,
      category: option.category ?? undefined,
    };
    if (option.type === "boolean") {
      return { ...common, type: "boolean", currentValue: option.currentValue };
    }
    return {
      ...common,
      type: "select",
      currentValue: option.currentValue,
      options: option.options.flatMap((item) =>
        "value" in item
          ? [
              {
                value: item.value,
                name: item.name,
                description: item.description ?? undefined,
              },
            ]
          : item.options.map((entry) => ({
              value: entry.value,
              name: entry.name,
              description: entry.description ?? undefined,
              group: item.name,
            })),
      ),
    };
  });
}

function toolContent(content?: ToolCallContent[] | null): {
  diffs?: AgentToolDiff[];
} {
  const diffs = (content ?? []).flatMap((item) =>
    item.type === "diff"
      ? [
          {
            path: item.path,
            oldText: item.oldText ?? "",
            newText: item.newText,
          },
        ]
      : [],
  );
  return diffs.length ? { diffs } : {};
}

function normalizeLocations(
  locations?: Array<{ path: string; line?: number | null }> | null,
): AgentToolLocation[] | undefined {
  if (!locations?.length) return undefined;
  return locations.map((location) => ({
    path: location.path,
    ...(location.line == null ? {} : { line: location.line }),
  }));
}

function assertInsideWorkspace(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`ACP access outside workspace denied: ${target}`);
  }
}

async function resolveWorkspacePath(
  root: string,
  target: string,
  mustExist: boolean,
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  if ((await fs.realpath(resolvedRoot)) !== resolvedRoot) {
    throw new Error("ACP workspace changed after the session started");
  }
  const resolvedTarget = path.resolve(resolvedRoot, target);
  assertInsideWorkspace(resolvedRoot, resolvedTarget);
  try {
    const realTarget = await fs.realpath(resolvedTarget);
    assertInsideWorkspace(resolvedRoot, realTarget);
    return realTarget;
  } catch (error) {
    if (mustExist || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let existing = path.dirname(resolvedTarget);
  const missing: string[] = [path.basename(resolvedTarget)];
  while (true) {
    try {
      const realParent = await fs.realpath(existing);
      assertInsideWorkspace(resolvedRoot, realParent);
      const candidate = path.join(realParent, ...missing.reverse());
      assertInsideWorkspace(resolvedRoot, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

async function writeWorkspaceTextFile(
  root: string,
  target: string,
  content: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const candidate = await resolveWorkspacePath(resolvedRoot, target, false);
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  const parent = await resolveWorkspacePath(resolvedRoot, path.dirname(candidate), true);
  const destination = path.join(parent, path.basename(candidate));
  assertInsideWorkspace(resolvedRoot, destination);
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(
    destination,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      noFollow,
    0o666,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function isAuthError(error: unknown): boolean {
  return /auth|login|credential|unauthor/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
