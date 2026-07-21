import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import { serialize } from "node:v8";
import path from "node:path";
import { z } from "zod";
import { CH, type ChannelName } from "../../shared/channels";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_REQUESTS = 600;
const HIGH_FREQUENCY_MAX_REQUESTS = 5_000;
const MAX_STRING_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_OBJECT_FIELDS = 1_024;

type IpcEvent = IpcMainInvokeEvent | IpcMainEvent;
export interface IpcRegistration {
  handle(channel: string, listener: Parameters<IpcMain["handle"]>[1]): void;
  on(channel: string, listener: Parameters<IpcMain["on"]>[1]): IpcRegistration;
  removeHandler(channel: string): void;
}

interface RequestPolicy {
  schema: z.ZodType;
  maxBytes?: number;
  maxRequests?: number;
}

interface RateState {
  count: number;
  startedAt: number;
}

export interface SecureIpcOptions {
  isTrustedSender(event: IpcEvent): boolean;
  authorize?(channel: ChannelName, args: readonly unknown[]): void | Promise<void>;
  maxMessageBytes?: number;
  maxRequests?: number;
  windowMs?: number;
}

const text = (max = 4_096) =>
  z.string().max(max).refine(value => !value.includes("\0"), "must not contain NUL");
const identifier = text(256);
const absolutePath = text(4_096).refine(value => path.isAbsolute(value), {
  message: "must be an absolute path",
});
const integer = z.number().int();
const positiveInteger = integer.positive();
const bool = z.boolean();
const stringList = z.array(text(4_096)).max(4_096);

const noArgs = z.tuple([]);
const oneText = z.tuple([text()]);
const oneId = z.tuple([identifier]);
const onePath = z.tuple([absolutePath]);
const rootAndPaths = z.tuple([absolutePath, stringList]);
const optionalBoolean = z.union([z.tuple([]), z.tuple([bool.optional()])]);
const optionalText = (schema = text()) =>
  z.union([z.tuple([]), z.tuple([schema.optional()])]);

const env = z.record(text(256), z.union([text(MAX_STRING_BYTES), z.null()])).refine(
  value => Object.keys(value).length <= 256,
  "too many environment entries",
);
const terminalOptions = z
  .object({
    cwd: absolutePath.optional(),
    cols: positiveInteger.max(1_000).optional(),
    rows: positiveInteger.max(1_000).optional(),
    shell: text(4_096).optional(),
    executable: text(4_096).optional(),
    args: stringList.optional(),
    env: env.optional(),
  })
  .strict();

const settingsKeys = new Set(Object.keys(DEFAULT_SETTINGS));
const settingsPatch = z.record(text(128), z.unknown()).superRefine((value, context) => {
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > settingsKeys.size) {
    context.addIssue({ code: "custom", message: "invalid settings patch size" });
  }
  for (const key of keys) {
    if (!settingsKeys.has(key)) {
      context.addIssue({ code: "custom", message: `unknown setting: ${key}` });
    }
  }
});

const permissionResponse = z
  .object({
    requestId: identifier,
    behavior: z.enum(["allow", "deny"]).optional(),
    optionId: identifier.optional(),
    cancelled: bool.optional(),
    message: text(8_192).optional(),
  })
  .strict();
const answerValue = z.union([text(MAX_STRING_BYTES), z.array(text(8_192)).max(128), z.number(), bool]);
const askResponse = z
  .object({
    requestId: identifier,
    answers: z.record(text(8_192), answerValue),
    response: text(MAX_STRING_BYTES).optional(),
    action: z.enum(["accept", "decline", "cancel"]).optional(),
  })
  .strict();
const acpServer = z
  .object({
    id: identifier,
    name: text(512),
    command: text(4_096),
    args: stringList,
    env: z.record(text(256), text(MAX_STRING_BYTES)),
    secretEnv: z.record(text(256), identifier).optional(),
    authArgsPrefix: stringList.optional(),
  })
  .strict();
const runtime = z.discriminatedUnion("type", [
  z.object({ type: z.literal("logos") }).strict(),
  z.object({ type: z.literal("claude") }).strict(),
  z.object({ type: z.literal("acp"), server: acpServer }).strict(),
]);
const thinking = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adaptive") }).strict(),
  z.object({ type: z.literal("disabled") }).strict(),
  z.object({ type: z.literal("enabled"), budgetTokens: positiveInteger.optional() }).strict(),
]);
const agentStart = z
  .object({
    sessionId: identifier,
    prompt: text(MAX_STRING_BYTES),
    cwd: absolutePath,
    additionalDirectories: z.array(absolutePath).max(64).optional(),
    model: text(512).optional(),
    permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
    resume: identifier.optional(),
    effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
    thinking: thinking.optional(),
    allowedTools: z.array(identifier).max(256).optional(),
    disallowedTools: z.array(identifier).max(256).optional(),
    settingSources: z.array(z.enum(["user", "project", "local"])).max(3).optional(),
    apiKey: text(16_384).optional(),
    authToken: text(16_384).optional(),
    baseUrl: text(4_096).optional(),
    runtime: runtime.optional(),
  })
  .strict();
const agentAuthContext = z
  .object({
    cwd: absolutePath.optional(),
    apiKey: text(16_384).optional(),
    authToken: text(16_384).optional(),
    baseUrl: text(4_096).optional(),
  })
  .strict();
const provider = z
  .object({
    id: identifier,
    apiType: identifier,
    baseUrl: text(4_096),
    headers: z.record(text(256), text(16_384)).optional(),
  })
  .strict();

const lspResourceOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), path: absolutePath, overwrite: bool.optional() }).strict(),
  z.object({ kind: z.literal("rename"), from: absolutePath, to: absolutePath, overwrite: bool.optional() }).strict(),
  z.object({ kind: z.literal("delete"), path: absolutePath }).strict(),
]);
const lspFileOperation = z
  .object({
    paths: z.array(absolutePath).max(4_096).optional(),
    kinds: z.array(z.enum(["file", "folder"])).max(4_096).optional(),
    renames: z
      .array(
        z
          .object({
            from: absolutePath,
            to: absolutePath,
            kind: z.enum(["file", "folder"]).optional(),
          })
          .strict(),
      )
      .max(4_096)
      .optional(),
  })
  .strict();
const lspResponse = z
  .object({ result: z.unknown().optional(), error: text(16_384).optional() })
  .strict();

const debugConfiguration = z
  .object({
    name: text(1_024),
    type: identifier,
    request: z.enum(["launch", "attach"]),
  })
  .passthrough();
const sourceBreakpoint = z
  .object({
    line: positiveInteger,
    column: positiveInteger.optional(),
    condition: text(8_192).optional(),
    hitCondition: text(8_192).optional(),
    logMessage: text(8_192).optional(),
  })
  .strict();
const debugStart = z
  .object({
    sessionId: identifier.optional(),
    configuration: debugConfiguration,
    initialBreakpoints: z.record(absolutePath, z.array(sourceBreakpoint).max(10_000)).optional(),
    exceptionBreakpoints: z.array(identifier).max(256).optional(),
  })
  .strict();

const REQUEST_POLICIES: Readonly<Partial<Record<ChannelName, RequestPolicy>>> = {
  [CH.fsReadDir]: { schema: onePath },
  [CH.fsReadFile]: { schema: onePath },
  [CH.fsReadFileSnapshot]: { schema: onePath },
  [CH.fsWriteFile]: { schema: z.tuple([absolutePath, text(8 * 1024 * 1024)]), maxBytes: 9 * 1024 * 1024 },
  [CH.fsWriteFileConditional]: { schema: z.tuple([absolutePath, text(8 * 1024 * 1024), text(256)]), maxBytes: 9 * 1024 * 1024 },
  [CH.fsStat]: { schema: onePath },
  [CH.fsCreateFile]: { schema: z.tuple([absolutePath, text(8 * 1024 * 1024).optional()]), maxBytes: 9 * 1024 * 1024 },
  [CH.fsCreateDir]: { schema: onePath },
  [CH.fsRename]: { schema: z.tuple([absolutePath, absolutePath]) },
  [CH.fsDelete]: { schema: onePath },
  [CH.fsExists]: { schema: onePath },
  [CH.fsWatch]: { schema: onePath },
  [CH.fsUnwatch]: { schema: onePath },

  [CH.dialogOpenFolder]: { schema: noArgs, maxRequests: 30 },
  [CH.dialogOpenFile]: { schema: noArgs, maxRequests: 30 },
  [CH.dialogSaveFile]: { schema: optionalText(absolutePath), maxRequests: 30 },
  [CH.workspaceGetRoot]: { schema: noArgs },
  [CH.workspaceGetFolders]: { schema: noArgs },
  [CH.workspaceSetRoot]: { schema: onePath, maxRequests: 60 },
  [CH.workspaceAddFolder]: { schema: noArgs, maxRequests: 30 },
  [CH.workspaceRemoveFolder]: { schema: onePath, maxRequests: 60 },
  [CH.workspaceRecent]: { schema: noArgs },

  [CH.extensionsList]: { schema: noArgs },
  [CH.extensionsInstall]: { schema: oneId, maxRequests: 30 },
  [CH.extensionsUninstall]: { schema: oneId, maxRequests: 30 },

  [CH.gitStatus]: { schema: onePath },
  [CH.gitStage]: { schema: rootAndPaths },
  [CH.gitUnstage]: { schema: rootAndPaths },
  [CH.gitDiscard]: { schema: rootAndPaths },
  [CH.gitCommit]: { schema: z.tuple([absolutePath, text(MAX_STRING_BYTES)]) },
  [CH.gitCommitAmend]: { schema: z.tuple([absolutePath, text(MAX_STRING_BYTES)]) },
  [CH.gitHead]: { schema: onePath },
  [CH.gitUndoLastCommit]: { schema: onePath },
  [CH.gitBranches]: { schema: onePath },
  [CH.gitCheckout]: { schema: z.tuple([absolutePath, text(1_024)]) },
  [CH.gitCreateBranch]: { schema: z.tuple([absolutePath, text(1_024)]) },
  [CH.gitDiff]: { schema: z.tuple([absolutePath, text(4_096), bool]) },
  [CH.gitFileDiff]: { schema: z.tuple([absolutePath, text(4_096), bool]) },
  [CH.gitLog]: { schema: z.tuple([absolutePath, positiveInteger.max(10_000).optional()]) },
  [CH.gitGraph]: { schema: z.tuple([absolutePath, positiveInteger.max(10_000).optional()]) },
  [CH.gitBlame]: { schema: z.tuple([absolutePath, absolutePath, positiveInteger]) },
  [CH.gitInit]: { schema: onePath },
  [CH.gitFetch]: { schema: onePath },
  [CH.gitPull]: { schema: onePath },
  [CH.gitPush]: { schema: onePath },
  [CH.gitSync]: { schema: onePath },
  [CH.gitWatch]: { schema: z.tuple([z.array(absolutePath).max(64)]), maxRequests: 120 },

  [CH.terminalCreate]: { schema: z.tuple([terminalOptions]), maxRequests: 60 },
  [CH.terminalWrite]: { schema: z.tuple([identifier, text(64 * 1024)]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.terminalResize]: { schema: z.tuple([identifier, positiveInteger.max(1_000), positiveInteger.max(1_000)]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.terminalKill]: { schema: oneId },

  [CH.settingsGetAll]: { schema: noArgs },
  [CH.settingsSet]: { schema: z.tuple([settingsPatch]) },
  [CH.settingsReset]: { schema: noArgs },
  [CH.settingsGetPath]: { schema: noArgs },
  [CH.settingsSetAcpSecret]: { schema: z.tuple([identifier, identifier, text(64 * 1024), identifier.optional()]) },
  [CH.settingsDeleteAcpSecret]: { schema: oneId },

  [CH.agentStart]: { schema: z.tuple([agentStart]), maxBytes: 2 * 1024 * 1024 },
  [CH.agentInterrupt]: { schema: oneId },
  [CH.agentClose]: { schema: oneId },
  [CH.agentRespondPermission]: { schema: z.tuple([permissionResponse]) },
  [CH.agentRespondAsk]: { schema: z.tuple([askResponse]) },
  [CH.agentListModels]: { schema: z.tuple([agentAuthContext.optional()]) },
  [CH.agentListCommands]: { schema: z.tuple([agentAuthContext.optional()]) },
  [CH.agentSetMode]: { schema: z.tuple([identifier, identifier]) },
  [CH.agentSetModel]: { schema: z.tuple([identifier, text(512)]) },
  [CH.agentSetConfig]: { schema: z.tuple([z.object({ sessionId: identifier, configId: identifier, value: z.union([text(16_384), bool]) }).strict()]) },
  [CH.agentAuthenticate]: { schema: z.tuple([z.object({ sessionId: identifier, methodId: identifier, completed: bool.optional() }).strict()]) },
  [CH.agentListProviders]: { schema: oneId },
  [CH.agentSetProvider]: { schema: z.tuple([identifier, provider]) },
  [CH.agentDisableProvider]: { schema: z.tuple([identifier, identifier]) },
  [CH.agentAuthStatus]: { schema: noArgs },
  [CH.agentLoginChatGPT]: { schema: noArgs, maxRequests: 10 },
  [CH.agentSetOpenAIKey]: { schema: z.tuple([text(16_384)]), maxRequests: 30 },
  [CH.agentLogoutOpenAI]: { schema: noArgs, maxRequests: 30 },
  [CH.agentRegistryList]: { schema: optionalBoolean },
  [CH.agentRegistryResolve]: { schema: oneId, maxRequests: 60 },

  [CH.lspList]: { schema: noArgs },
  [CH.lspInstall]: { schema: oneId, maxRequests: 30 },
  [CH.lspUninstall]: { schema: oneId, maxRequests: 30 },
  [CH.lspStart]: { schema: z.tuple([identifier, absolutePath]), maxRequests: 120 },
  [CH.lspStop]: { schema: oneId },
  [CH.lspRequest]: { schema: z.tuple([identifier, text(256), z.unknown(), integer.optional()]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.lspSendNotification]: { schema: z.tuple([identifier, text(256), z.unknown()]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.lspCancelRequest]: { schema: z.tuple([identifier, integer]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.lspFileOperation]: { schema: z.tuple([z.enum(["willCreate", "didCreate", "willRename", "didRename", "willDelete", "didDelete"]), lspFileOperation]) },
  [CH.lspResourceOperation]: { schema: z.tuple([lspResourceOperation]) },
  [CH.lspDirectoryIsEmpty]: { schema: onePath },
  [CH.lspClientResponse]: { schema: z.tuple([integer, lspResponse]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.lspCheckUpdates]: { schema: noArgs, maxRequests: 30 },

  [CH.debugList]: { schema: noArgs },
  [CH.debugListAdapters]: { schema: noArgs },
  [CH.debugStart]: { schema: z.tuple([debugStart]), maxRequests: 60 },
  [CH.debugStop]: { schema: z.tuple([identifier, bool.optional()]) },
  [CH.debugRequest]: { schema: z.tuple([identifier, identifier, z.unknown().optional()]), maxRequests: HIGH_FREQUENCY_MAX_REQUESTS },
  [CH.debugSetBreakpoints]: { schema: z.tuple([identifier, absolutePath, z.array(sourceBreakpoint).max(10_000)]) },

  [CH.appVersions]: { schema: noArgs },
  [CH.appPlatform]: { schema: noArgs },
  [CH.appOpenExternal]: { schema: oneText, maxRequests: 60 },
  [CH.windowControl]: { schema: z.tuple([z.enum(["minimize", "maximize", "unmaximize", "close"])]) },
};

function assertSafeStructuredValue(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error("IPC payload exceeds structural limits.");
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > MAX_STRING_BYTES) {
        throw new Error("IPC payload contains an oversized string.");
      }
      return;
    }
    if (
      candidate == null ||
      candidate === undefined ||
      typeof candidate === "boolean" ||
      typeof candidate === "bigint"
    ) {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("IPC payload contains a non-finite number.");
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS) {
        throw new Error("IPC payload contains an oversized array.");
      }
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (typeof candidate !== "object") {
      throw new Error("IPC payload contains an unsupported value.");
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("IPC payload must contain only plain objects.");
    }
    const entries = Object.entries(candidate);
    if (entries.length > MAX_OBJECT_FIELDS) {
      throw new Error("IPC payload contains an oversized object.");
    }
    for (const [key, item] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error("IPC payload contains a forbidden object key.");
      }
      visit(key, depth + 1);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function policyFor(channel: string): RequestPolicy {
  const policy = REQUEST_POLICIES[channel as ChannelName];
  if (!policy) {
    throw new Error(`No IPC security policy is defined for '${channel}'.`);
  }
  return policy;
}

function senderKey(event: IpcEvent): string {
  return String(event.sender?.id ?? "unknown");
}

export function createSecureIpcMain(
  ipcMain: IpcRegistration,
  options: SecureIpcOptions,
): IpcRegistration {
  const rateStates = new Map<string, RateState>();
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const defaultMaxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;

  const verify = async (
    channel: string,
    event: IpcEvent,
    args: readonly unknown[],
  ): Promise<void> => {
    if (!options.isTrustedSender(event)) {
      throw new Error("IPC request did not originate from the workbench main frame.");
    }
    const policy = policyFor(channel);
    const now = Date.now();
    const key = `${senderKey(event)}:${channel}`;
    const current = rateStates.get(key);
    const state = !current || now - current.startedAt >= windowMs
      ? { count: 0, startedAt: now }
      : current;
    state.count += 1;
    rateStates.set(key, state);
    if (state.count > (policy.maxRequests ?? defaultMaxRequests)) {
      throw new Error(`IPC rate limit exceeded for '${channel}'.`);
    }
    const size = serialize(args).byteLength;
    if (size > (policy.maxBytes ?? maxMessageBytes)) {
      throw new Error(`IPC payload for '${channel}' exceeds its byte limit.`);
    }
    assertSafeStructuredValue(args);
    const result = policy.schema.safeParse(args);
    if (!result.success) {
      const reason = result.error.issues[0]?.message ?? "invalid payload";
      throw new Error(`Invalid IPC payload for '${channel}': ${reason}.`);
    }

    await options.authorize?.(channel as ChannelName, args);
  };

  return {
    handle(channel, listener) {
      policyFor(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        await verify(channel, event, args);
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      policyFor(channel);
      ipcMain.on(channel, (event, ...args) => {
        void verify(channel, event, args).then(
          () => listener(event, ...args),
          () => undefined,
        );
      });
      return this;
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
  };
}
