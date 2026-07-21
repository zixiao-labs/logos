import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { CH } from "../../shared/channels";
import type {
  AgentAskResponse,
  AgentAuthRequest,
  AgentAuthContext,
  AgentEvent,
  AgentModelInfo,
  AgentPermissionOption,
  AgentPermissionResponse,
  AgentProviderConfig,
  AgentSetConfigRequest,
  AgentQuestion,
  AgentSlashCommand,
  AgentStartRequest,
} from "../../shared/types";
import type { ServiceContext } from "./context";
import type {
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { AcpAgentRuntime } from "./acp-agent";
import { LogosAgentRuntime } from "./logos-agent";
import { OpenAIAuthStore } from "./openai-auth";
import type { AcpSecretStore } from "./acp-secrets";

/**
 * `@anthropic-ai/claude-agent-sdk` is ESM-only. The Electron main bundle is
 * emitted as CJS, so a normal import would be rewritten to `require()` and
 * fail. Building the dynamic import through `new Function` hides it from the
 * bundler, yielding a genuine runtime `import()` that Node resolves as ESM.
 */
const importEsm = new Function(
  "m",
  "return import(m)",
) as (m: string) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;

/**
 * Resolve the native `claude` CLI binary the SDK spawns, returning a path the OS
 * can actually execute when we run packaged inside an Electron asar.
 *
 * The SDK locates this binary with `createRequire(import.meta.url).resolve(...)`
 * and hands it straight to `child_process.spawn`. In a packaged build that path
 * lands *inside* `app.asar` (`…/app.asar/node_modules/@anthropic-ai/
 * claude-agent-sdk-<plat>-<arch>/claude`). Electron transparently redirects fs
 * *reads* of unpacked files to `app.asar.unpacked`, but `spawn` is a raw syscall
 * that is **not** redirected — so the kernel tries to descend into `app.asar`
 * (a single file, not a directory) and the call fails with `spawn ENOTDIR`. Dev
 * has no asar, so the SDK's own resolution works there — hence prod-only breakage.
 *
 * We pre-resolve the binary ourselves and rewrite the `app.asar` path segment to
 * `app.asar.unpacked`, where electron-builder placed the real, signed binary (see
 * the `asarUnpack` globs in package.json). Returns undefined when not running
 * from an asar (dev) or when the platform binary isn't installed, leaving the SDK
 * to fall back to its own resolution exactly as before.
 */
function resolveClaudeExecutable(): string | undefined {
  try {
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    const base = "@anthropic-ai/claude-agent-sdk";
    const { platform, arch } = process;
    // Mirror the SDK's own candidate order (musl before glibc on linux).
    const candidates =
      platform === "linux"
        ? [`${base}-linux-${arch}-musl`, `${base}-linux-${arch}`]
        : [`${base}-${platform}-${arch}`];
    const req = createRequire(__filename);
    const marker = `app.asar${sep}`;
    for (const pkg of candidates) {
      let resolved: string;
      try {
        resolved = req.resolve(`${pkg}/${exe}`);
      } catch {
        continue; // not the platform variant installed for this build
      }
      // Only intervene for the packaged asar case; dev resolves to a real path
      // already and should keep using the SDK's own resolution unchanged.
      if (!resolved.includes(marker)) return undefined;
      const unpacked = resolved.replace(marker, `app.asar.unpacked${sep}`);
      if (existsSync(unpacked)) return unpacked;
    }
  } catch {
    /* fall through to the SDK's built-in resolution */
  }
  return undefined;
}

/** Packaged-asar-safe path to the CLI binary, resolved once. undefined in dev. */
const CLAUDE_EXECUTABLE = resolveClaudeExecutable();

/**
 * Build the subprocess environment from supplied credentials. The SDK
 * *replaces* `env` wholesale (it does not merge), so we must spread
 * `process.env`. When the user supplied no credential we return `undefined` and
 * omit `env` entirely — the subprocess then inherits the main process env as
 * before, preserving the terminal-launched dev flow (ANTHROPIC_* / ~/.claude).
 */
function authEnv(ctx: {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}): NodeJS.ProcessEnv | undefined {
  const overrides: Record<string, string> = {};
  if (ctx.apiKey) overrides.ANTHROPIC_API_KEY = ctx.apiKey;
  if (ctx.authToken) overrides.ANTHROPIC_AUTH_TOKEN = ctx.authToken;
  if (ctx.baseUrl) overrides.ANTHROPIC_BASE_URL = ctx.baseUrl;
  if (Object.keys(overrides).length === 0) return undefined;
  return { ...process.env, ...overrides };
}

/** Minimal push/pull async queue used as the SDK's streaming input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const msg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    } as unknown as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  close(): void {
    this.closed = true;
    let w;
    while ((w = this.waiters.shift()))
      w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.buffer.length)
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface ClaudeSession {
  kind: "claude";
  input: InputQueue;
  query: Query;
  closed: boolean;
  /** Current assistant message per root/subagent stream. */
  currentMessageIds: Map<string, string>;
}

interface AcpSession {
  kind: "acp";
  runtime: AcpAgentRuntime;
}

interface LogosSession {
  kind: "logos";
  runtime: LogosAgentRuntime;
}

type Session = ClaudeSession | AcpSession | LogosSession;

class SessionStartCancelled extends Error {}

/** A `canUseTool` call awaiting the user's response from the renderer. */
interface PendingRequest {
  sessionId: string;
  source: "claude" | "logos-permission" | "acp-permission" | "acp-ask";
  resolve: (r: never) => void;
  /** Present when the request originated from the AskUserQuestion tool. */
  questions?: AgentQuestion[];
  options?: AgentPermissionOption[];
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string"
          ? b
          : b?.type === "text"
            ? b.text
            : JSON.stringify(b),
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

export function registerAgentService(
  ctx: ServiceContext,
  acpSecrets?: AcpSecretStore,
): () => Promise<void> {
  const { ipcMain } = ctx;
  const sessions = new Map<string, Session>();
  const startingSessions = new Map<string, Promise<Session>>();
  const startingFingerprints = new Map<string, string>();
  const sessionGenerations = new Map<string, number>();
  const pendingPerms = new Map<string, PendingRequest>();
  const openAIAuth = new OpenAIAuthStore(ctx.userDataDir);
  let shuttingDown = false;
  let permCounter = 0;

  const emit = (e: AgentEvent) => ctx.send(CH.agentEvent, e);

  function cancelPending(sessionId: string): void {
    for (const [requestId, pending] of pendingPerms) {
      if (pending.sessionId !== sessionId) continue;
      pendingPerms.delete(requestId);
      if (pending.source === "acp-permission") {
        pending.resolve({ cancelled: true } as never);
      } else if (pending.source === "acp-ask") {
        pending.resolve({ action: "cancel", answers: {} } as never);
      } else if (pending.source === "logos-permission") {
        pending.resolve(false as never);
      } else {
        pending.resolve({
          behavior: "deny",
          message: "Cancelled by user",
        } as never);
      }
    }
  }

  function routeMessage(
    msg: SDKMessage,
    sessionId: string,
    session: ClaudeSession,
  ) {
    switch (msg.type) {
      case "system": {
        const system = msg as unknown as Record<string, unknown>;
        const subtype = String(system.subtype ?? "system");
        if (
          subtype === "task_started" ||
          subtype === "task_progress" ||
          subtype === "task_updated" ||
          subtype === "task_notification"
        ) {
          const patch = (system.patch ?? {}) as Record<string, unknown>;
          const rawStatus = String(
            patch.status ?? system.status ?? (subtype === "task_started" ? "running" : "running"),
          );
          const status =
            rawStatus === "completed"
              ? "completed"
              : rawStatus === "failed"
                ? "failed"
                : rawStatus === "stopped" || rawStatus === "killed"
                  ? "stopped"
                  : rawStatus === "pending"
                    ? "pending"
                    : "running";
          emit({
            kind: "subagent",
            sessionId,
            taskId: String(system.task_id ?? system.tool_use_id ?? crypto.randomUUID()),
            toolUseId: system.tool_use_id ? String(system.tool_use_id) : undefined,
            agentType: system.subagent_type ? String(system.subagent_type) : undefined,
            description: String(
              patch.description ??
                system.description ??
                system.summary ??
                "Subagent task",
            ),
            status,
            summary: system.summary ? String(system.summary) : undefined,
          });
        }
        emit({
          kind: "system",
          sessionId,
          subtype,
          data: msg,
        });
        break;
      }
      case "stream_event": {
        const partial = msg as unknown as {
          event: Record<string, unknown>;
          parent_tool_use_id?: string | null;
        };
        const ev = partial.event;
        const parentToolUseId = partial.parent_tool_use_id ?? undefined;
        const streamKey = parentToolUseId ?? "root";
        if (ev.type === "message_start") {
          const m = ev.message as { id?: string } | undefined;
          session.currentMessageIds.set(
            streamKey,
            m?.id ?? crypto.randomUUID(),
          );
        } else if (ev.type === "content_block_delta") {
          const delta = ev.delta as {
            type?: string;
            text?: string;
            thinking?: string;
          };
          const messageId =
            session.currentMessageIds.get(streamKey) ?? crypto.randomUUID();
          session.currentMessageIds.set(streamKey, messageId);
          if (delta.type === "text_delta" && delta.text) {
            emit({
              kind: "text-delta",
              sessionId,
              messageId,
              delta: delta.text,
              parentToolUseId,
            });
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            emit({
              kind: "thinking",
              sessionId,
              messageId,
              delta: delta.thinking,
              parentToolUseId,
            });
          }
        }
        break;
      }
      case "assistant": {
        const assistant = msg as unknown as {
          message: { id: string; content: unknown[] };
          parent_tool_use_id?: string | null;
        };
        const m = assistant.message;
        const parentToolUseId = assistant.parent_tool_use_id ?? undefined;
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            emit({
              kind: "text",
              sessionId,
              messageId: m.id,
              text: String(block.text ?? ""),
              parentToolUseId,
            });
          } else if (block.type === "tool_use") {
            const input = block.input;
            const locations = toolLocations(input);
            emit({
              kind: "tool-use",
              sessionId,
              toolUseId: String(block.id),
              name: String(block.name),
              input,
              parentToolUseId,
              status: "in_progress",
              locations,
            });
            if (locations[0]) {
              emit({ kind: "follow", sessionId, location: locations[0] });
            }
            const name = String(block.name).toLowerCase();
            if (name === "todowrite" || name === "update_plan") {
              const todos = (input as { todos?: Array<Record<string, unknown>> })
                ?.todos;
              if (Array.isArray(todos)) {
                emit({
                  kind: "plan",
                  sessionId,
                  entries: todos.map((todo) => ({
                    content: String(todo.content ?? todo.activeForm ?? "Task"),
                    status:
                      todo.status === "in_progress" || todo.status === "completed"
                        ? todo.status
                        : "pending",
                    priority:
                      todo.priority === "high" || todo.priority === "low"
                        ? todo.priority
                        : "medium",
                  })),
                });
              }
            }
          }
        }
        break;
      }
      case "user": {
        const user = msg as unknown as {
          message: { content: unknown };
          parent_tool_use_id?: string | null;
        };
        const m = user.message;
        const parentToolUseId = user.parent_tool_use_id ?? undefined;
        const content = m.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "tool_result") {
              emit({
                kind: "tool-result",
                sessionId,
                toolUseId: String(block.tool_use_id),
                isError: Boolean(block.is_error),
                content: stringifyContent(block.content),
                parentToolUseId,
              });
            }
          }
        }
        break;
      }
      case "result": {
        const r = msg as unknown as {
          subtype: string;
          is_error: boolean;
          duration_ms: number;
          total_cost_usd?: number;
          usage: unknown;
          session_id: string;
        };
        emit({
          kind: "result",
          sessionId,
          sdkSessionId: r.session_id ?? null,
          isError: r.is_error,
          durationMs: r.duration_ms,
          costUsd: r.total_cost_usd ?? null,
          usage: r.usage,
        });
        break;
      }
      default:
        break;
    }
  }

  async function startClaudeSession(req: AgentStartRequest): Promise<ClaudeSession> {
    const sdk = await importEsm("@anthropic-ai/claude-agent-sdk");
    const input = new InputQueue();
    const env = authEnv(req);
    const effort = req.effort === "none" ? undefined : req.effort;
    const options: Options = {
      cwd: req.cwd,
      ...(req.additionalDirectories?.length
        ? { additionalDirectories: req.additionalDirectories }
        : {}),
      model: req.model || undefined,
      permissionMode: req.permissionMode ?? "default",
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      // Packaged builds must spawn the unpacked CLI binary, not the asar path
      // the SDK would resolve itself (which yields `spawn ENOTDIR`). undefined
      // in dev, where the SDK's own resolution already works.
      ...(CLAUDE_EXECUTABLE
        ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE }
        : {}),
      // B1: when credentials were supplied, `env` is a MERGE of process.env +
      // ANTHROPIC_* overrides (see authEnv). When omitted, the subprocess
      // inherits process.env as before.
      ...(env ? { env } : {}),
      // B2/F2: conditional-spread so an unset control means "no override".
      ...(req.resume ? { resume: req.resume } : {}),
      ...(effort ? { effort } : {}),
      ...(req.thinking ? { thinking: req.thinking } : {}),
      ...(req.allowedTools?.length ? { allowedTools: req.allowedTools } : {}),
      ...(req.disallowedTools?.length
        ? { disallowedTools: req.disallowedTools }
        : {}),
      ...(req.settingSources?.length
        ? { settingSources: req.settingSources }
        : {}),
      canUseTool: (toolName, toolInput) => {
        const requestId = `req-${++permCounter}`;
        return new Promise<PermissionResult>((resolve) => {
          // The AskUserQuestion tool is Claude asking the user a clarifying
          // question — surface the questions instead of an allow/deny prompt.
          if (toolName === "AskUserQuestion") {
            const questions =
              (toolInput as { questions?: AgentQuestion[] }).questions ?? [];
            pendingPerms.set(requestId, {
              sessionId: req.sessionId,
              source: "claude",
              resolve: resolve as (r: never) => void,
              questions,
            });
            emit({ kind: "ask", sessionId: req.sessionId, requestId, questions });
            return;
          }
          pendingPerms.set(requestId, {
            sessionId: req.sessionId,
            source: "claude",
            resolve: resolve as (r: never) => void,
          });
          emit({
            kind: "permission",
            sessionId: req.sessionId,
            requestId,
            toolName,
            input: toolInput,
          });
        });
      },
    };

    const query = sdk.query({ prompt: input, options });
    const session: ClaudeSession = {
      kind: "claude",
      input,
      query,
      closed: false,
      currentMessageIds: new Map(),
    };
    // Consume the message stream for the lifetime of the session.
    (async () => {
      try {
        for await (const msg of query) routeMessage(msg, req.sessionId, session);
      } catch (err) {
        emit({
          kind: "error",
          sessionId: req.sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        session.closed = true;
        if (sessions.get(req.sessionId) === session) {
          sessions.delete(req.sessionId);
        }
      }
    })();

    void Promise.all([query.supportedModels(), query.supportedCommands()])
      .then(([models, commands]) =>
        emit({
          kind: "runtime-ready",
          sessionId: req.sessionId,
          runtimeName: "Claude",
          sdkSessionId: req.resume ?? "",
          modes: [
            { id: "default", name: "Build" },
            { id: "plan", name: "Plan" },
            { id: "acceptEdits", name: "Accept edits" },
          ],
          currentModeId: req.permissionMode ?? "default",
          models: models.map((model) => ({
            value: model.value,
            displayName: model.displayName,
            description: model.description,
            supportsEffort: model.supportsEffort,
            supportedEffortLevels: model.supportedEffortLevels,
            supportsAdaptiveThinking: model.supportsAdaptiveThinking,
          })),
          currentModelId: req.model,
          configOptions: [],
          commands: commands.map((command) => ({
            name: command.name,
            description: command.description,
            argumentHint: command.argumentHint,
            aliases: command.aliases,
          })),
          authMethods: [],
          canConfigureProviders: false,
        }),
      )
      .catch(() => undefined);

    return session;
  }

  const acpHooks = {
    emit,
    requestPermission(
      sessionId: string,
      toolName: string,
      input: unknown,
      options: AgentPermissionOption[],
    ) {
      const requestId = `req-${++permCounter}`;
      return new Promise<{ optionId?: string; cancelled?: boolean }>((resolve) => {
        pendingPerms.set(requestId, {
          sessionId,
          source: "acp-permission",
          resolve: resolve as (r: never) => void,
          options,
        });
        emit({
          kind: "permission",
          sessionId,
          requestId,
          toolName,
          input,
          options,
        });
      });
    },
    requestAsk(sessionId: string, questions: AgentQuestion[]) {
      const requestId = `req-${++permCounter}`;
      return new Promise<{
        action: "accept" | "cancel";
        answers: Record<string, string | string[] | number | boolean>;
      }>((resolve) => {
        pendingPerms.set(requestId, {
          sessionId,
          source: "acp-ask",
          resolve: resolve as (r: never) => void,
          questions,
        });
        emit({ kind: "ask", sessionId, requestId, questions });
      });
    },
    closed(sessionId: string) {
      cancelPending(sessionId);
      sessions.delete(sessionId);
    },
  };

  const logosHooks = {
    emit,
    requestPermission(
      sessionId: string,
      toolName: string,
      input: unknown,
      options?: AgentPermissionOption[],
    ) {
      const requestId = `req-${++permCounter}`;
      return new Promise<boolean>((resolve) => {
        pendingPerms.set(requestId, {
          sessionId,
          source: "logos-permission",
          resolve: resolve as (r: never) => void,
        });
        emit({
          kind: "permission",
          sessionId,
          requestId,
          toolName,
          input,
          options,
        });
      });
    },
    debug: ctx.debug,
    closed(sessionId: string) {
      cancelPending(sessionId);
      sessions.delete(sessionId);
    },
  };

  async function createSession(req: AgentStartRequest): Promise<Session> {
    if (req.runtime?.type === "acp") {
      const server = req.runtime.server;
      const secretEnv = Object.keys(server.secretEnv ?? {}).length
        ? await acpSecrets?.resolve(server.id, server.secretEnv)
        : {};
      if (Object.keys(server.secretEnv ?? {}).length && !acpSecrets) {
        throw new Error("ACP secret storage is unavailable");
      }
      const runtime = await AcpAgentRuntime.create(
        {
          ...req,
          runtime: {
            type: "acp",
            server: {
              ...server,
              env: { ...server.env, ...secretEnv },
              secretEnv: undefined,
            },
          },
        },
        acpHooks,
      );
      return { kind: "acp", runtime };
    }
    if (req.runtime?.type === "logos") {
      const runtime = await LogosAgentRuntime.create(
        req,
        logosHooks,
        openAIAuth,
        `${ctx.userDataDir}/agent-sessions`,
      );
      return { kind: "logos", runtime };
    }
    return startClaudeSession(req);
  }

  async function disposeSession(
    session: Session,
    removeHistory = false,
  ): Promise<void> {
    if (session.kind === "claude") {
      session.input.close();
      await session.query.interrupt().catch(() => undefined);
    } else if (session.kind === "logos") {
      await session.runtime.dispose(removeHistory);
    } else {
      await session.runtime.dispose();
    }
  }

  function startFingerprint(req: AgentStartRequest): string {
    const runtimeId =
      req.runtime?.type === "acp"
        ? `acp:${req.runtime.server.id}`
        : (req.runtime?.type ?? "claude");
    return JSON.stringify([
      resolve(req.cwd),
      [...(req.additionalDirectories ?? [])].map(directory => resolve(directory)).sort(),
      runtimeId,
    ]);
  }

  async function getOrCreateSession(req: AgentStartRequest): Promise<Session> {
    const existing = sessions.get(req.sessionId);
    if (existing) return existing;
    let starting = startingSessions.get(req.sessionId);
    const fingerprint = startFingerprint(req);
    if (
      starting &&
      startingFingerprints.get(req.sessionId) !== fingerprint
    ) {
      throw new Error("Concurrent agent starts disagree on workspace or runtime");
    }
    if (!starting) {
      const generation = sessionGenerations.get(req.sessionId) ?? 0;
      starting = createSession(req).then(async (session) => {
        if (
          shuttingDown ||
          (sessionGenerations.get(req.sessionId) ?? 0) !== generation
        ) {
          await disposeSession(session, true);
          throw new SessionStartCancelled();
        }
        if (session.kind === "claude" && session.closed) {
          await disposeSession(session, true);
          throw new SessionStartCancelled();
        }
        sessions.set(req.sessionId, session);
        return session;
      });
      startingSessions.set(req.sessionId, starting);
      startingFingerprints.set(req.sessionId, fingerprint);
      void starting.finally(() => {
        if (startingSessions.get(req.sessionId) === starting) {
          startingSessions.delete(req.sessionId);
          startingFingerprints.delete(req.sessionId);
        }
      }).catch(() => undefined);
    }
    return starting;
  }

  ipcMain.handle(CH.agentStart, async (_e, req: AgentStartRequest) => {
    const generation = sessionGenerations.get(req.sessionId) ?? 0;
    try {
      let session = sessions.get(req.sessionId);
      if (
        session?.kind === "logos" &&
        !(await session.runtime.matchesWorkspace(req.cwd, req.additionalDirectories))
      ) {
        emit({
          kind: "error",
          sessionId: req.sessionId,
          message: "This agent thread belongs to a different workspace. Create a new thread to continue.",
        });
        return;
      }
      if (!session) session = await getOrCreateSession(req);
      if (
        session.kind === "logos" &&
        !(await session.runtime.matchesWorkspace(req.cwd, req.additionalDirectories))
      ) {
        emit({
          kind: "error",
          sessionId: req.sessionId,
          message: "This agent thread belongs to a different workspace. Create a new thread to continue.",
        });
        return;
      }
      if (
        sessions.get(req.sessionId) !== session ||
        (sessionGenerations.get(req.sessionId) ?? 0) !== generation
      ) return;
      if (session.kind === "claude") session.input.push(req.prompt);
      else {
        if (session.kind === "logos") {
          session.runtime.setEffort(req.effort);
          session.runtime.setToolPolicy(req.allowedTools, req.disallowedTools);
        }
        await session.runtime.prompt(req.prompt);
      }
    } catch (err) {
      if (err instanceof SessionStartCancelled) return;
      emit({
        kind: "error",
        sessionId: req.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ipcMain.handle(CH.agentInterrupt, async (_e, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    cancelPending(sessionId);
    try {
      if (session.kind === "claude") await session.query.interrupt();
      else await session.runtime.interrupt();
    } catch {
      /* not interruptible in current state */
    }
  });

  ipcMain.handle(CH.agentClose, async (_e, sessionId: string) => {
    sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1);
    startingSessions.delete(sessionId);
    startingFingerprints.delete(sessionId);
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    cancelPending(sessionId);
    if (!session) return;
    await disposeSession(session, true);
  });

  ipcMain.handle(
    CH.agentRespondPermission,
    (_e, res: AgentPermissionResponse) => {
      const pending = pendingPerms.get(res.requestId);
      if (!pending) return;
      pendingPerms.delete(res.requestId);
      if (pending.source === "acp-permission") {
        const fallback = pending.options?.find((option) =>
          res.behavior === "allow"
            ? option.kind.startsWith("allow")
            : option.kind.startsWith("reject"),
        );
        pending.resolve(
          (res.cancelled
            ? { cancelled: true }
            : { optionId: res.optionId ?? fallback?.id }) as never,
        );
      } else if (pending.source === "logos-permission") {
        pending.resolve((res.behavior === "allow" && !res.cancelled) as never);
      } else if (res.behavior === "allow") {
        pending.resolve({ behavior: "allow" } as never);
      } else {
        pending.resolve({
          behavior: "deny",
          message: res.message ?? "Denied by user",
        } as never);
      }
    },
  );

  ipcMain.handle(CH.agentRespondAsk, (_e, res: AgentAskResponse) => {
    const pending = pendingPerms.get(res.requestId);
    if (!pending) return;
    pendingPerms.delete(res.requestId);
    // The original questions array MUST be echoed back alongside the answers.
    if (pending.source === "acp-ask") {
      pending.resolve(
        {
          action: res.action === "cancel" || res.action === "decline" ? "cancel" : "accept",
          answers: res.answers,
        } as never,
      );
      return;
    }
    if (res.action === "cancel" || res.action === "decline") {
      pending.resolve({
        behavior: "deny",
        message: "Question cancelled by user",
      } as never);
      return;
    }
    const updatedInput = res.response
      ? { questions: pending.questions ?? [], response: res.response }
      : { questions: pending.questions ?? [], answers: res.answers };
    pending.resolve({ behavior: "allow", updatedInput } as never);
  });

  ipcMain.handle(CH.agentSetMode, async (_e, sessionId: string, modeId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.kind === "claude") {
      await session.query.setPermissionMode(
        modeId as "default" | "acceptEdits" | "bypassPermissions" | "plan",
      );
      emit({ kind: "mode", sessionId, modeId });
    } else {
      await session.runtime.setMode(modeId);
    }
  });

  ipcMain.handle(CH.agentSetModel, async (_e, sessionId: string, modelId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.kind === "claude") await session.query.setModel(modelId || undefined);
    else await session.runtime.setModel(modelId);
  });

  ipcMain.handle(CH.agentSetConfig, async (_e, input: AgentSetConfigRequest) => {
    const session = sessions.get(input.sessionId);
    if (session?.kind === "acp") await session.runtime.setConfig(input);
  });

  ipcMain.handle(CH.agentAuthenticate, async (_e, input: AgentAuthRequest) => {
    const session = sessions.get(input.sessionId);
    if (session?.kind === "acp") return session.runtime.authenticate(input);
    if (session?.kind === "logos") {
      if (input.methodId !== "chatgpt") {
        throw new Error("Add the OpenAI API key in Settings, then retry.");
      }
      await openAIAuth.loginChatGPT();
      await notifyLogosCredentialsChanged();
      return {};
    }
    return {};
  });

  ipcMain.handle(CH.agentListProviders, async (_e, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session?.kind === "acp" ? session.runtime.listProviders() : [];
  });

  ipcMain.handle(
    CH.agentSetProvider,
    async (_e, sessionId: string, config: AgentProviderConfig) => {
      const session = sessions.get(sessionId);
      if (session?.kind === "acp") await session.runtime.setProvider(config);
    },
  );

  ipcMain.handle(
    CH.agentDisableProvider,
    async (_e, sessionId: string, providerId: string) => {
      const session = sessions.get(sessionId);
      if (session?.kind === "acp") await session.runtime.disableProvider(providerId);
    },
  );

  const notifyLogosCredentialsChanged = async () => {
    for (const session of sessions.values()) {
      if (session.kind === "logos") await session.runtime.credentialsChanged();
    }
  };

  ipcMain.handle(CH.agentAuthStatus, () => openAIAuth.status());
  ipcMain.handle(CH.agentLoginChatGPT, async () => {
    const status = await openAIAuth.loginChatGPT();
    await notifyLogosCredentialsChanged();
    return status;
  });
  ipcMain.handle(CH.agentSetOpenAIKey, async (_e, apiKey: string) => {
    const status = await openAIAuth.setApiKey(apiKey);
    await notifyLogosCredentialsChanged();
    return status;
  });
  ipcMain.handle(CH.agentLogoutOpenAI, async () => {
    await openAIAuth.logout();
    await notifyLogosCredentialsChanged();
  });

  // D1/D4: probe the SDK for the model + slash-command lists. Control requests
  // require streaming mode, so we spin a short-lived streaming query, read the
  // lists from the init handshake, then tear it down. The result depends on the
  // supplied credentials/cwd, so cache it per credential fingerprint — a single
  // global cache would hand back the first account's models after creds change.
  // Failures (e.g. no auth) are not cached so a later call can retry.
  type AgentInfo = { models: AgentModelInfo[]; commands: AgentSlashCommand[] };
  const infoCache = new Map<string, AgentInfo>();
  const infoInflight = new Map<string, Promise<AgentInfo>>();

  // Fingerprint the fields that change what the probe returns: endpoint +
  // credentials, plus cwd (project-scoped slash commands depend on it). Secrets
  // are hashed, not stored verbatim, so the key can't leak credentials into a
  // heap snapshot or crash dump while still distinguishing auth contexts.
  const digest = (v?: string): string =>
    v ? createHash("sha256").update(v).digest("hex") : "";
  const probeKey = (ctx: AgentAuthContext): string =>
    JSON.stringify([
      ctx.baseUrl ?? "",
      digest(ctx.apiKey),
      digest(ctx.authToken),
      ctx.cwd ?? "",
    ]);

  async function probeInfo(ctx: AgentAuthContext): Promise<AgentInfo> {
    const key = probeKey(ctx);
    const cached = infoCache.get(key);
    if (cached) return cached;
    const inflight = infoInflight.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      const sdk = await importEsm("@anthropic-ai/claude-agent-sdk");
      const input = new InputQueue();
      const env = authEnv(ctx);
      const query = sdk.query({
        prompt: input,
        options: {
          cwd: ctx.cwd,
          includePartialMessages: false,
          ...(env ? { env } : {}),
          // Same packaged-asar spawn fix as startSession (see CLAUDE_EXECUTABLE).
          ...(CLAUDE_EXECUTABLE
            ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE }
            : {}),
        },
      });
      // Drain in the background so the control-message read loop runs.
      void (async () => {
        try {
          for await (const _msg of query) void _msg;
        } catch {
          /* ignore */
        }
      })();
      try {
        // Guard against a subprocess that starts but never answers control
        // requests — don't leave the probe (and its child process) pending.
        const timeout = new Promise<never>((_, reject) => {
          const tm = setTimeout(() => reject(new Error("probe timeout")), 15000);
          if (typeof tm === "object" && "unref" in tm) tm.unref();
        });
        const [models, commands] = await Promise.race([
          Promise.all([
            query.supportedModels().catch(() => [] as ModelInfo[]),
            query.supportedCommands().catch(() => [] as SlashCommand[]),
          ]),
          timeout,
        ]);
        const result = {
          models: models.map(
            (m): AgentModelInfo => ({
              value: m.value,
              displayName: m.displayName,
              description: m.description,
              supportsEffort: m.supportsEffort,
              supportedEffortLevels: m.supportedEffortLevels,
              supportsAdaptiveThinking: m.supportsAdaptiveThinking,
            }),
          ),
          commands: commands.map(
            (c): AgentSlashCommand => ({
              name: c.name,
              description: c.description,
              argumentHint: c.argumentHint,
              aliases: c.aliases,
            }),
          ),
        };
        if (result.models.length || result.commands.length)
          infoCache.set(key, result);
        return result;
      } finally {
        input.close();
        try {
          await query.interrupt();
        } catch {
          /* ignore */
        }
      }
    })();
    infoInflight.set(key, promise);
    try {
      return await promise;
    } finally {
      infoInflight.delete(key);
    }
  }

  ipcMain.handle(CH.agentListModels, (_e, ctx: AgentAuthContext = {}) =>
    probeInfo(ctx)
      .then((i) => i.models)
      .catch(() => [] as AgentModelInfo[]),
  );
  ipcMain.handle(CH.agentListCommands, (_e, ctx: AgentAuthContext = {}) =>
    probeInfo(ctx)
      .then((i) => i.commands)
      .catch(() => [] as AgentSlashCommand[]),
  );

  return async () => {
    shuttingDown = true;
    for (const sessionId of startingSessions.keys()) {
      sessionGenerations.set(
        sessionId,
        (sessionGenerations.get(sessionId) ?? 0) + 1,
      );
    }
    const starting = [...startingSessions.values()];
    startingSessions.clear();
    startingFingerprints.clear();
    const active = [...sessions.entries()];
    sessions.clear();
    for (const [sessionId] of active) cancelPending(sessionId);
    await Promise.allSettled([
      ...active.map(([, session]) => disposeSession(session)),
      ...starting,
    ]);
    pendingPerms.clear();
  };
}

function toolLocations(input: unknown): Array<{ path: string; line?: number }> {
  if (!input || typeof input !== "object") return [];
  const value = input as Record<string, unknown>;
  const candidate = value.file_path ?? value.path ?? value.filename;
  if (typeof candidate !== "string") return [];
  const line = value.line ?? value.line_number;
  return [
    {
      path: candidate,
      ...(typeof line === "number" ? { line } : {}),
    },
  ];
}
