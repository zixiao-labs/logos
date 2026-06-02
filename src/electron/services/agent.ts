import { CH } from "../../shared/channels";
import type {
  AgentAskResponse,
  AgentAuthContext,
  AgentEvent,
  AgentModelInfo,
  AgentPermissionResponse,
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

interface Session {
  input: InputQueue;
  query: Query;
  /** id of the assistant message currently streaming, for delta grouping. */
  currentMessageId: string | null;
}

/** A `canUseTool` call awaiting the user's response from the renderer. */
interface PendingRequest {
  resolve: (r: PermissionResult) => void;
  /** Present when the request originated from the AskUserQuestion tool. */
  questions?: AgentQuestion[];
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

export function registerAgentService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const sessions = new Map<string, Session>();
  const pendingPerms = new Map<string, PendingRequest>();
  let permCounter = 0;

  const emit = (e: AgentEvent) => ctx.send(CH.agentEvent, e);

  function routeMessage(msg: SDKMessage, sessionId: string, session: Session) {
    switch (msg.type) {
      case "system":
        emit({
          kind: "system",
          sessionId,
          subtype: (msg as { subtype: string }).subtype,
          data: msg,
        });
        break;
      case "stream_event": {
        const ev = (msg as unknown as { event: Record<string, unknown> }).event;
        if (ev.type === "message_start") {
          const m = ev.message as { id?: string } | undefined;
          session.currentMessageId = m?.id ?? null;
        } else if (ev.type === "content_block_delta") {
          const delta = ev.delta as {
            type?: string;
            text?: string;
            thinking?: string;
          };
          const messageId = session.currentMessageId ?? "stream";
          if (delta.type === "text_delta" && delta.text) {
            emit({ kind: "text-delta", sessionId, messageId, delta: delta.text });
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            emit({ kind: "thinking", sessionId, messageId, delta: delta.thinking });
          }
        }
        break;
      }
      case "assistant": {
        const m = (msg as unknown as { message: { id: string; content: unknown[] } })
          .message;
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            emit({
              kind: "text",
              sessionId,
              messageId: m.id,
              text: String(block.text ?? ""),
            });
          } else if (block.type === "tool_use") {
            emit({
              kind: "tool-use",
              sessionId,
              toolUseId: String(block.id),
              name: String(block.name),
              input: block.input,
            });
          }
        }
        break;
      }
      case "user": {
        const m = (msg as unknown as { message: { content: unknown } }).message;
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

  async function startSession(req: AgentStartRequest): Promise<Session> {
    const sdk = await importEsm("@anthropic-ai/claude-agent-sdk");
    const input = new InputQueue();
    const env = authEnv(req);
    const options: Options = {
      cwd: req.cwd,
      model: req.model || undefined,
      permissionMode: req.permissionMode ?? "default",
      includePartialMessages: true,
      // B1: when credentials were supplied, `env` is a MERGE of process.env +
      // ANTHROPIC_* overrides (see authEnv). When omitted, the subprocess
      // inherits process.env as before.
      ...(env ? { env } : {}),
      // B2/F2: conditional-spread so an unset control means "no override".
      ...(req.resume ? { resume: req.resume } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
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
            pendingPerms.set(requestId, { resolve, questions });
            emit({ kind: "ask", sessionId: req.sessionId, requestId, questions });
            return;
          }
          pendingPerms.set(requestId, { resolve });
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
    const session: Session = { input, query, currentMessageId: null };
    sessions.set(req.sessionId, session);

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
        sessions.delete(req.sessionId);
      }
    })();

    return session;
  }

  ipcMain.handle(CH.agentStart, async (_e, req: AgentStartRequest) => {
    try {
      let session = sessions.get(req.sessionId);
      if (!session) session = await startSession(req);
      session.input.push(req.prompt);
    } catch (err) {
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
    try {
      await session.query.interrupt();
    } catch {
      /* not interruptible in current state */
    }
  });

  ipcMain.handle(
    CH.agentRespondPermission,
    (_e, res: AgentPermissionResponse) => {
      const pending = pendingPerms.get(res.requestId);
      if (!pending) return;
      pendingPerms.delete(res.requestId);
      if (res.behavior === "allow") pending.resolve({ behavior: "allow" });
      else
        pending.resolve({
          behavior: "deny",
          message: res.message ?? "Denied by user",
        });
    },
  );

  ipcMain.handle(CH.agentRespondAsk, (_e, res: AgentAskResponse) => {
    const pending = pendingPerms.get(res.requestId);
    if (!pending) return;
    pendingPerms.delete(res.requestId);
    // The original questions array MUST be echoed back alongside the answers.
    const updatedInput = res.response
      ? { questions: pending.questions ?? [], response: res.response }
      : { questions: pending.questions ?? [], answers: res.answers };
    pending.resolve({ behavior: "allow", updatedInput });
  });

  // D1/D4: probe the SDK for the model + slash-command lists. Control requests
  // require streaming mode, so we spin a short-lived streaming query, read the
  // lists from the init handshake, then tear it down. Cached after the first
  // success (subprocess cost paid once); failures (e.g. no auth) are not cached
  // so a later call after credentials are set can retry.
  let infoCache: {
    models: AgentModelInfo[];
    commands: AgentSlashCommand[];
  } | null = null;
  let infoInflight: Promise<{
    models: AgentModelInfo[];
    commands: AgentSlashCommand[];
  }> | null = null;

  async function probeInfo(ctx: AgentAuthContext): Promise<{
    models: AgentModelInfo[];
    commands: AgentSlashCommand[];
  }> {
    if (infoCache) return infoCache;
    if (infoInflight) return infoInflight;
    infoInflight = (async () => {
      const sdk = await importEsm("@anthropic-ai/claude-agent-sdk");
      const input = new InputQueue();
      const env = authEnv(ctx);
      const query = sdk.query({
        prompt: input,
        options: {
          cwd: ctx.cwd,
          includePartialMessages: false,
          ...(env ? { env } : {}),
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
        if (result.models.length || result.commands.length) infoCache = result;
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
    try {
      return await infoInflight;
    } finally {
      infoInflight = null;
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

  return () => {
    for (const s of sessions.values()) {
      s.input.close();
      s.query.interrupt?.().catch(() => undefined);
    }
    sessions.clear();
    pendingPerms.clear();
  };
}
