import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { CH } from "../../shared/channels";
import type {
  DapArguments,
  DapBreakpoint,
  DapCapabilities,
  DapEvent,
  DapRequest,
  DapResponse,
  DapSourceBreakpoint,
  DebugAdapterDescriptor,
  DebugAdapterExecutable,
  DebugAdapterExecutableServer,
  DebugAdapterInfo,
  DebugLaunchConfiguration,
  DebugSessionInfo,
  DebugSessionStatus,
  DebugStartRequest,
} from "../../shared/dap";
import type { ServiceContext } from "./context";
import { DapConnection } from "./dap-transport";
import { augmentPath } from "./path-env";

type SpawnProcess = typeof spawn;

interface DebugSession {
  info: DebugSessionInfo;
  configuration: DebugLaunchConfiguration;
  dapType: string;
  connection: DapConnection;
  adapterProcess?: ChildProcessWithoutNullStreams;
  adapterEndpoint?: { host: string; port: number };
  adapterOutputFromStdout: boolean;
  socket?: net.Socket;
  terminalProcesses: Set<ChildProcess>;
  terminalIds: Set<string>;
  breakpoints: Map<string, DapSourceBreakpoint[]>;
  breakpointVersions: Map<string, number>;
  exceptionBreakpoints: string[];
  readyForBreakpoints: boolean;
  configurationStarted: boolean;
  initializationTimer?: ReturnType<typeof setTimeout>;
  executionEventCounter: number;
  startController: AbortController;
  shutdownPromise?: Promise<void>;
  userStopRequested: boolean;
  disposed: boolean;
}

interface DebugServiceDependencies {
  spawnProcess: SpawnProcess;
  connectSocket(
    port: number,
    host: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<net.Socket>;
}

interface DebugTransport {
  connection: DapConnection;
  adapterProcess?: ChildProcessWithoutNullStreams;
  socket?: net.Socket;
  endpoint?: { host: string; port: number };
}

interface PendingDebugStart {
  info: DebugSessionInfo;
  controller: AbortController;
  transport?: DebugTransport;
}

const BUILTIN_TYPES: Record<string, string> = {
  node: "Node.js",
  chrome: "Chrome",
  electron: "Electron",
  "pwa-node": "Node.js",
  "pwa-chrome": "Chrome",
  "pwa-extensionHost": "Electron",
};

function cloneInfo(session: DebugSession): DebugSessionInfo {
  return {
    ...session.info,
    capabilities: { ...session.info.capabilities },
  };
}

function asArguments(value: unknown): DapArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as DapArguments;
}

function configurationArguments(
  configuration: DebugLaunchConfiguration,
  dapType: string,
): DapArguments {
  const { adapter: _adapter, ...dapConfiguration } = configuration;
  if (configuration.type === "electron") delete dapConfiguration.renderer;
  return { ...dapConfiguration, type: dapType };
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  if (environment[name] != null || process.platform !== "win32") {
    return environment[name];
  }
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? environment[key] : undefined;
}

function resolveConfigurationEnvironment(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): unknown {
  if (typeof value === "string") {
    const unsupported = value.match(/\$\{(command|input):[^}]+\}/);
    if (unsupported) {
      throw new Error(
        `Debug variable '${unsupported[0]}' is not supported by Logos`,
      );
    }
    return value.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) =>
      environmentValue(environment, name) ?? "",
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigurationEnvironment(item, environment));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveConfigurationEnvironment(item, environment),
      ]),
    );
  }
  return value;
}

function mergeEnvironment(
  overrides: Record<string, string | null> | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  augmentPath(result);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (process.platform === "win32") {
      for (const existingKey of Object.keys(result)) {
        if (existingKey.toLowerCase() === key.toLowerCase()) delete result[existingKey];
      }
    }
    if (value == null) delete result[key];
    else result[key] = value;
  }
  return result;
}

function electronRendererConfiguration(
  configuration: DebugLaunchConfiguration,
): DebugLaunchConfiguration | undefined {
  if (configuration.type !== "electron" || configuration.request !== "launch") {
    return undefined;
  }
  const renderer = configuration.renderer;
  if (renderer == null || renderer === false) return undefined;
  if (!renderer || typeof renderer !== "object" || Array.isArray(renderer)) {
    throw new Error("Electron renderer configuration must be an object");
  }
  const options = asArguments(renderer);
  const port = options.port;
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65_535) {
    throw new Error("Electron renderer debug port must be an integer from 1 to 65535");
  }
  const {
    name,
    type: _type,
    request: _request,
    adapter: _adapter,
    ...attachOptions
  } = options;
  return {
    ...attachOptions,
    name:
      typeof name === "string" && name
        ? name
        : `${configuration.name}: Renderer`,
    type: "pwa-chrome",
    request: "attach",
    address:
      typeof attachOptions.address === "string"
        ? attachOptions.address
        : "127.0.0.1",
    port,
    timeout:
      typeof attachOptions.timeout === "number" ? attachOptions.timeout : 30_000,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultConnectSocket(
  port: number,
  host: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Debug session start cancelled"));
      return;
    }
    const socket = net.createConnection({ port, host });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new Error("Debug session start cancelled"));
    };
    timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to debug adapter at ${host}:${port}`));
    }, timeoutMs);
    socket.once("error", onError);
    socket.once("connect", onConnect);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function availablePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Unable to allocate a debug adapter port"));
        else resolve(port);
      });
    });
  });
}

function builtInDapType(type: string): string {
  if (type === "node" || type === "electron") return "pwa-node";
  if (type === "chrome") return "pwa-chrome";
  return type;
}

function jsDebugCandidates(ctx: ServiceContext): string[] {
  const resourceRoot = process.resourcesPath;
  const candidates = [
    path.join(
      resourceRoot,
      "debug-adapters",
      "js-debug",
      "src",
      "dapDebugServer.js",
    ),
    path.join(
      resourceRoot,
      "debug-adapters",
      "js-debug",
      "dist",
      "src",
      "dapDebugServer.js",
    ),
    path.join(
      ctx.userDataDir,
      "debug-adapters",
      "js-debug",
      "src",
      "dapDebugServer.js",
    ),
  ];
  if (!ctx.isPackaged) {
    candidates.unshift(
      path.join(
        process.cwd(),
        "build",
        "debug-adapters",
        "js-debug",
        "src",
        "dapDebugServer.js",
      ),
    );
  }
  return candidates;
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next packaged/managed adapter location.
    }
  }
  return null;
}

async function resolveAdapter(
  ctx: ServiceContext,
  configuration: DebugLaunchConfiguration,
): Promise<DebugAdapterDescriptor> {
  if (configuration.adapter) return configuration.adapter;
  if (!(configuration.type in BUILTIN_TYPES)) {
    throw new Error(
      `Debug configuration '${configuration.name}' must define an adapter`,
    );
  }

  const entry = await firstExisting(jsDebugCandidates(ctx));
  if (!entry) {
    throw new Error(
      `The built-in ${BUILTIN_TYPES[configuration.type]} debug adapter is not installed`,
    );
  }
  return {
    type: "executable-server",
    command: process.execPath,
    args: [entry, "${port}", "${host}"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    host: "127.0.0.1",
  };
}

async function adapterInfo(ctx: ServiceContext): Promise<DebugAdapterInfo[]> {
  const jsDebug = await firstExisting(jsDebugCandidates(ctx));
  return [
    {
      type: "node",
      label: "Node.js",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug
        ? { message: "JavaScript debug adapter is not installed" }
        : {}),
    },
    {
      type: "chrome",
      label: "Chrome",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug
        ? { message: "JavaScript debug adapter is not installed" }
        : {}),
    },
    {
      type: "electron",
      label: "Electron",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug
        ? { message: "JavaScript debug adapter is not installed" }
        : {}),
    },
    {
      type: "pwa-node",
      label: "Node.js",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug ? { message: "JavaScript debug adapter is not installed" } : {}),
    },
    {
      type: "pwa-chrome",
      label: "Chrome",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug ? { message: "JavaScript debug adapter is not installed" } : {}),
    },
    {
      type: "pwa-extensionHost",
      label: "Electron",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug ? { message: "JavaScript debug adapter is not installed" } : {}),
    },
    {
      type: "custom",
      label: "Custom DAP Adapter",
      builtIn: false,
      available: true,
    },
  ];
}

/** Register the main-process DAP session manager. */
export function registerDebugService(
  ctx: ServiceContext,
  dependencies: Partial<DebugServiceDependencies> = {},
): () => void {
  const { ipcMain } = ctx;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const connectSocket = dependencies.connectSocket ?? defaultConnectSocket;
  const sessions = new Map<string, DebugSession>();
  const pendingStarts = new Map<string, PendingDebugStart>();

  const killProcessTree = (child: ChildProcess, force = false) => {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
      killer.unref();
      return;
    }
    const signal = force ? "SIGKILL" : "SIGTERM";
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process may not be a group leader (for example in injected tests).
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the checks above.
    }
  };

  const stopProcessTree = (child: ChildProcess) => {
    killProcessTree(child);
    const forceTimer = setTimeout(() => killProcessTree(child, true), 1_000);
    forceTimer.unref();
    child.once("exit", () => clearTimeout(forceTimer));
  };

  const disposeTransport = (transport: DebugTransport | undefined) => {
    transport?.connection.dispose();
    transport?.socket?.destroy();
    if (transport?.adapterProcess) {
      stopProcessTree(transport.adapterProcess);
    }
  };

  const connectWithCancellation = (
    port: number,
    host: string,
    timeoutMs: number | undefined,
    signal: AbortSignal,
  ): Promise<net.Socket> => {
    if (signal.aborted) {
      return Promise.reject(new Error("Debug session start cancelled"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new Error("Debug session start cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void connectSocket(port, host, timeoutMs, signal).then(
        (socket) => {
          signal.removeEventListener("abort", onAbort);
          if (settled || signal.aborted) {
            socket.destroy();
            return;
          }
          settled = true;
          resolve(socket);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  };

  const cancelPendingStart = (pendingStart: PendingDebugStart) => {
    if (pendingStart.controller.signal.aborted) return;
    pendingStart.controller.abort();
    disposeTransport(pendingStart.transport);
    ctx.send(CH.debugEvent, {
      kind: "session",
      session: {
        ...pendingStart.info,
        status: "terminated",
        message: undefined,
      },
    });
  };

  const publishSession = (session: DebugSession) =>
    ctx.send(CH.debugEvent, { kind: "session", session: cloneInfo(session) });

  const setStatus = (
    session: DebugSession,
    status: DebugSessionStatus,
    message?: string,
  ) => {
    session.info = {
      ...session.info,
      status,
      ...(message ? { message } : { message: undefined }),
    };
    publishSession(session);
  };

  const cleanupSession = (
    session: DebugSession,
    terminateDebuggee = true,
  ) => {
    if (session.disposed) return;
    session.disposed = true;
    if (session.initializationTimer) {
      clearTimeout(session.initializationTimer);
      session.initializationTimer = undefined;
    }
    for (const pendingStart of pendingStarts.values()) {
      if (pendingStart.info.parentSessionId === session.info.id) {
        cancelPendingStart(pendingStart);
      }
    }
    for (const child of sessions.values()) {
      if (child.info.parentSessionId !== session.info.id) continue;
      if (child.info.status !== "terminated") setStatus(child, "terminated");
      cleanupSession(child);
    }
    session.connection.dispose();
    session.socket?.destroy();
    if (session.adapterProcess) {
      stopProcessTree(session.adapterProcess);
    }
    if (terminateDebuggee) {
      for (const child of session.terminalProcesses) {
        stopProcessTree(child);
      }
      for (const terminalId of session.terminalIds) {
        ctx.terminal?.kill(terminalId);
      }
    }
    session.terminalProcesses.clear();
    session.terminalIds.clear();
    sessions.delete(session.info.id);
  };

  const failSession = (session: DebugSession, error: unknown) => {
    if (session.disposed) return;
    const expected =
      session.info.status === "terminating" ||
      session.info.status === "terminated";
    setStatus(
      session,
      expected ? "terminated" : "error",
      expected ? undefined : errorMessage(error),
    );
    cleanupSession(session);
  };

  const sendBreakpoints = async (
    session: DebugSession,
    sourcePath: string,
    breakpoints: DapSourceBreakpoint[],
  ): Promise<DapBreakpoint[]> => {
    const version = (session.breakpointVersions.get(sourcePath) ?? 0) + 1;
    session.breakpointVersions.set(sourcePath, version);
    session.breakpoints.set(sourcePath, breakpoints);
    if (!session.readyForBreakpoints) {
      return breakpoints.map((breakpoint) => ({
        verified: false,
        line: breakpoint.line,
        column: breakpoint.column,
      }));
    }
    const response = await session.connection.sendRequest<{
      breakpoints?: DapBreakpoint[];
    }>("setBreakpoints", {
      source: { name: path.basename(sourcePath), path: sourcePath },
      breakpoints,
      lines: breakpoints.map((breakpoint) => breakpoint.line),
      sourceModified: false,
    }, 30_000);
    const result = response.body?.breakpoints ?? [];
    if (
      !session.disposed &&
      session.breakpointVersions.get(sourcePath) === version
    ) {
      ctx.send(CH.debugEvent, {
        kind: "breakpoints",
        sessionId: session.info.id,
        sourcePath,
        requestedBreakpoints: breakpoints,
        breakpoints: result,
      });
    }
    return result;
  };

  const rootSessionId = (session: DebugSession): string => {
    let current = session;
    const seen = new Set<string>();
    while (current.info.parentSessionId && !seen.has(current.info.id)) {
      seen.add(current.info.id);
      const parent = sessions.get(current.info.parentSessionId);
      if (!parent) break;
      current = parent;
    }
    return current.info.id;
  };

  const sendBreakpointsToSessionTree = async (
    session: DebugSession,
    sourcePath: string,
    breakpoints: DapSourceBreakpoint[],
  ): Promise<DapBreakpoint[]> => {
    const treeId = rootSessionId(session);
    const related = Array.from(sessions.values()).filter(
      (candidate) =>
        candidate !== session &&
        !candidate.disposed &&
        rootSessionId(candidate) === treeId,
    );
    const [primary] = await Promise.all([
      sendBreakpoints(session, sourcePath, breakpoints),
      Promise.all(
        related.map(async (candidate) => {
          try {
            await sendBreakpoints(candidate, sourcePath, breakpoints);
          } catch (error) {
            ctx.send(CH.debugEvent, {
              kind: "adapter-output",
              sessionId: candidate.info.id,
              category: "stderr",
              output: `Failed to update breakpoint in '${candidate.info.name}': ${errorMessage(error)}\n`,
            });
          }
        }),
      ),
    ]);
    return primary;
  };

  const sessionIsStopping = (session: DebugSession): boolean =>
    session.startController.signal.aborted ||
    session.disposed ||
    session.info.status === "terminating" ||
    session.info.status === "terminated";

  const ensureSessionStarting = (session: DebugSession): void => {
    if (sessionIsStopping(session)) {
      throw new Error("Debug session start cancelled");
    }
  };

  const armInitializationTimer = (session: DebugSession) => {
    if (session.initializationTimer) clearTimeout(session.initializationTimer);
    session.initializationTimer = setTimeout(() => {
      if (!session.disposed && session.info.status === "starting") {
        failSession(
          session,
          new Error("Debug adapter did not complete session configuration"),
        );
      }
    }, 30_000);
    session.initializationTimer.unref();
  };

  const configureSession = async (session: DebugSession) => {
    if (session.configurationStarted || session.disposed) return;
    session.configurationStarted = true;
    const errors: string[] = [];
    try {
      for (const [sourcePath, breakpoints] of session.breakpoints) {
        if (sessionIsStopping(session)) return;
        try {
          await sendBreakpoints(session, sourcePath, breakpoints);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
      if (
        session.info.capabilities.exceptionBreakpointFilters?.length ||
        !session.info.capabilities.supportsConfigurationDoneRequest
      ) {
        try {
          await session.connection.sendRequest(
            "setExceptionBreakpoints",
            { filters: session.exceptionBreakpoints },
            30_000,
          );
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
      if (sessionIsStopping(session)) return;
      if (session.info.capabilities.supportsConfigurationDoneRequest) {
        await session.connection.sendRequest("configurationDone", undefined, 30_000);
      }
      if (session.initializationTimer) {
        clearTimeout(session.initializationTimer);
        session.initializationTimer = undefined;
      }
      if (errors.length) {
        ctx.send(CH.debugEvent, {
          kind: "adapter-output",
          sessionId: session.info.id,
          category: "stderr",
          output: `Failed to configure some breakpoints: ${errors.join("; ")}\n`,
        });
      }
      if (session.info.status === "starting") setStatus(session, "running");
    } catch (error) {
      if (!sessionIsStopping(session)) failSession(session, error);
    }
  };

  const handleEvent = (session: DebugSession, event: DapEvent) => {
    if (session.disposed) return;
    if (event.event === "initialized") {
      session.readyForBreakpoints = true;
      void configureSession(session);
    } else if (event.event === "stopped") {
      session.executionEventCounter++;
      setStatus(session, "stopped");
    } else if (event.event === "continued") {
      session.executionEventCounter++;
      const body = asArguments(event.body);
      session.connection.cancelPendingRequests(
        ["threads", "stackTrace", "scopes", "variables", "evaluate"],
        session.info.capabilities.supportsCancelRequest === true,
      );
      if (body.allThreadsContinued !== false) setStatus(session, "running");
    } else if (event.event === "terminated") {
      setStatus(session, "terminated");
    } else if (event.event === "capabilities") {
      const body = asArguments(event.body);
      const capabilities = asArguments(body.capabilities) as DapCapabilities;
      session.info = {
        ...session.info,
        capabilities: { ...session.info.capabilities, ...capabilities },
      };
      publishSession(session);
    }
    ctx.send(CH.debugEvent, { kind: "dap", sessionId: session.info.id, event });
    if (event.event === "terminated") {
      const body = asArguments(event.body);
      const restartData = body.restart;
      const shouldRestart =
        !session.userStopRequested &&
        restartData != null &&
        restartData !== false;
      queueMicrotask(() => {
        if (session.disposed) return;
        const restartRequest: DebugStartRequest = {
          sessionId: session.info.id,
          configuration: {
            ...session.configuration,
            ...(shouldRestart ? { __restart: restartData } : {}),
          },
          initialBreakpoints: Object.fromEntries(session.breakpoints),
          exceptionBreakpoints: session.exceptionBreakpoints,
        };
        const parent = session.info.parentSessionId
          ? sessions.get(session.info.parentSessionId)
          : undefined;
        const adapterOverride =
          parent && session.adapterEndpoint
            ? ({ type: "server", ...session.adapterEndpoint } as const)
            : undefined;
        void stopSession(
          session,
          shouldRestart && session.info.request === "launch",
          false,
          shouldRestart,
        ).then(() => {
          if (!shouldRestart || session.userStopRequested) return;
          if (
            parent &&
            (parent.disposed || sessions.get(parent.info.id) !== parent)
          ) {
            return;
          }
          return startSession(restartRequest, adapterOverride, parent).then(
            () => undefined,
            () => undefined,
          );
        });
      });
    }
  };

  const runInTerminal = (
    session: DebugSession,
    request: DapRequest,
  ): void => {
    const args = request.arguments ?? {};
    const commandLine = Array.isArray(args.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    if (commandLine.length === 0) {
      session.connection.sendResponse(
        request,
        false,
        undefined,
        "runInTerminal requires a command",
      );
      return;
    }
    if (args.kind === "external") {
      session.connection.sendResponse(
        request,
        false,
        undefined,
        "External terminals are not supported",
      );
      return;
    }
    const envOverrides =
      args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? (args.env as Record<string, string | null>)
        : undefined;
    if (ctx.terminal) {
      try {
        const useShell = args.argsCanBeInterpretedByShell === true;
        const terminal = ctx.terminal.create({
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          env: envOverrides,
          ...(useShell
            ? process.platform === "win32"
              ? {
                  executable: process.env.COMSPEC || "cmd.exe",
                  args: ["/d", "/s", "/c", commandLine.join(" ")],
                }
              : {
                  executable: process.env.SHELL || "/bin/sh",
                  args: ["-c", commandLine.join(" ")],
                }
            : {
                executable: commandLine[0],
                args: commandLine.slice(1),
              }),
        });
        session.terminalIds.add(terminal.id);
        ctx.send(CH.debugEvent, {
          kind: "terminal",
          sessionId: session.info.id,
          terminal,
          title: typeof args.title === "string" ? args.title : undefined,
        });
        session.connection.sendResponse(request, true, {
          ...(useShell
            ? { shellProcessId: terminal.pid }
            : { processId: terminal.pid }),
        });
      } catch (error) {
        session.connection.sendResponse(
          request,
          false,
          undefined,
          errorMessage(error),
        );
      }
      return;
    }
    try {
      const child = spawnProcess(commandLine[0], commandLine.slice(1), {
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        env: mergeEnvironment(envOverrides),
        shell: args.argsCanBeInterpretedByShell === true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
        detached: process.platform !== "win32",
      });
      session.terminalProcesses.add(child);
      child.stdout?.on("data", (data: Buffer | string) => {
        ctx.send(CH.debugEvent, {
          kind: "adapter-output",
          sessionId: session.info.id,
          category: "stdout",
          output: data.toString(),
        });
      });
      child.stderr?.on("data", (data: Buffer | string) => {
        ctx.send(CH.debugEvent, {
          kind: "adapter-output",
          sessionId: session.info.id,
          category: "stderr",
          output: data.toString(),
        });
      });
      child.once("exit", () => session.terminalProcesses.delete(child));
      let responded = false;
      child.once("spawn", () => {
        responded = true;
        session.connection.sendResponse(request, true, {
          ...(child.pid
            ? args.argsCanBeInterpretedByShell === true
              ? { shellProcessId: child.pid }
              : { processId: child.pid }
            : {}),
        });
      });
      child.once("error", (error) => {
        if (!responded) {
          responded = true;
          session.connection.sendResponse(
            request,
            false,
            undefined,
            error.message,
          );
          return;
        }
        ctx.send(CH.debugEvent, {
          kind: "adapter-output",
          sessionId: session.info.id,
          category: "stderr",
          output: `${error.message}\n`,
        });
      });
    } catch (error) {
      session.connection.sendResponse(
        request,
        false,
        undefined,
        errorMessage(error),
      );
    }
  };

  let startSession: (
    request: DebugStartRequest,
    adapterOverride?: DebugAdapterDescriptor,
    parentSession?: DebugSession,
  ) => Promise<DebugSessionInfo>;
  let stopSession: (
    session: DebugSession,
    terminateDebuggee: boolean,
    sendTerminate?: boolean,
    restart?: boolean,
  ) => Promise<void>;

  const startChildSession = async (
    parent: DebugSession,
    request: DapRequest,
  ) => {
    const args = request.arguments ?? {};
    const configuration = asArguments(args.configuration);
    const requestKind = args.request;
    if (requestKind !== "launch" && requestKind !== "attach") {
      throw new Error("startDebugging requires a launch or attach request");
    }
    if (!parent.adapterEndpoint) {
      throw new Error("The parent debug adapter does not expose a reusable endpoint");
    }
    const childConfiguration: DebugLaunchConfiguration = {
      ...configuration,
      name:
        typeof configuration.name === "string" && configuration.name
          ? configuration.name
          : parent.configuration.name,
      type:
        typeof configuration.type === "string" && configuration.type
          ? configuration.type
          : parent.dapType,
      request: requestKind,
    };
    const child = await startSession(
      {
        configuration: childConfiguration,
        initialBreakpoints: Object.fromEntries(parent.breakpoints),
        exceptionBreakpoints: parent.exceptionBreakpoints,
      },
      { type: "server", ...parent.adapterEndpoint },
      parent,
    );
    if (child.status === "terminated") {
      throw new Error("Child debug session start cancelled");
    }
  };

  const handleReverseRequest = (session: DebugSession, request: DapRequest) => {
    if (request.command === "runInTerminal") {
      runInTerminal(session, request);
      return;
    }
    if (request.command === "startDebugging") {
      void startChildSession(session, request).then(
        () => {
          if (!session.disposed) session.connection.sendResponse(request, true);
        },
        (error) => {
          if (session.disposed) return;
          session.connection.sendResponse(
            request,
            false,
            undefined,
            errorMessage(error),
          );
        },
      );
      return;
    }
    session.connection.sendResponse(
      request,
      false,
      undefined,
      `Unsupported reverse request '${request.command}'`,
    );
  };

  const spawnAdapterProcess = async (
    descriptor: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string | null>;
    },
    signal: AbortSignal,
  ): Promise<ChildProcessWithoutNullStreams> => {
    if (signal.aborted) throw new Error("Debug session start cancelled");
    if (!descriptor.command.trim()) {
      throw new Error("Debug adapter command is empty");
    }
    if (path.isAbsolute(descriptor.command)) {
      await access(descriptor.command).catch(() => {
        throw new Error(
          `Debug adapter executable '${descriptor.command}' does not exist`,
        );
      });
    }
    if (signal.aborted) throw new Error("Debug session start cancelled");
    const child = spawnProcess(descriptor.command, descriptor.args ?? [], {
      cwd: descriptor.cwd,
      env: mergeEnvironment(descriptor.env),
      shell: false,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    // Keep Node's special EventEmitter "error" event handled between spawning
    // the process and attaching the session-level failure handler.
    child.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        stopProcessTree(child);
        reject(new Error("Debug session start cancelled"));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return child;
  };

  const openExecutable = async (
    descriptor: DebugAdapterExecutable,
    signal: AbortSignal,
  ): Promise<{
    connection: DapConnection;
    adapterProcess: ChildProcessWithoutNullStreams;
  }> => {
    const child = await spawnAdapterProcess(descriptor, signal);
    return {
      connection: new DapConnection(child.stdout, child.stdin),
      adapterProcess: child,
    };
  };

  const openExecutableServer = async (
    descriptor: DebugAdapterExecutableServer,
    signal: AbortSignal,
  ): Promise<{
    connection: DapConnection;
    adapterProcess: ChildProcessWithoutNullStreams;
    socket: net.Socket;
    endpoint: { host: string; port: number };
  }> => {
    const host = descriptor.host ?? "127.0.0.1";
    const port = descriptor.port ?? (await availablePort(host));
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error("Debug adapter server port is invalid");
    }
    const sourceArgs = descriptor.args ?? [];
    const hasPortVariable = sourceArgs.some((argument) =>
      argument.includes("${port}"),
    );
    const args = sourceArgs.map((argument) =>
      argument
        .replaceAll("${port}", String(port))
        .replaceAll("${host}", host),
    );
    if (!hasPortVariable) args.push(String(port));
    const child = await spawnAdapterProcess({ ...descriptor, args }, signal);
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (
      !signal.aborted &&
      Date.now() < deadline &&
      child.exitCode == null &&
      child.signalCode == null
    ) {
      try {
        const socket = await connectWithCancellation(
          port,
          host,
          Math.max(1, Math.min(1_000, deadline - Date.now())),
          signal,
        );
        return {
          socket,
          endpoint: { host, port },
          adapterProcess: child,
          connection: new DapConnection(socket, socket),
        };
      } catch (error) {
        lastError = error;
        if (signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    if (
      child.exitCode == null &&
      child.signalCode == null
    ) {
      stopProcessTree(child);
    }
    if (signal.aborted) throw new Error("Debug session start cancelled");
    if (child.exitCode != null || child.signalCode != null) {
      const suffix = child.signalCode
        ? `signal ${child.signalCode}`
        : `code ${child.exitCode ?? "unknown"}`;
      throw new Error(`Debug adapter exited with ${suffix}`);
    }
    throw new Error(
      `Unable to connect to debug adapter at ${host}:${port}: ${errorMessage(lastError)}`,
    );
  };

  startSession = async (
    request: DebugStartRequest,
    adapterOverride?: DebugAdapterDescriptor,
    parentSession?: DebugSession,
  ) => {
    const configurationEnvironment = mergeEnvironment(undefined);
    request = {
      ...request,
      configuration: resolveConfigurationEnvironment(
        request.configuration,
        configurationEnvironment,
      ) as DebugLaunchConfiguration,
    };
    const rendererConfiguration = parentSession
      ? undefined
      : electronRendererConfiguration(request.configuration);
    const id = request.sessionId ?? randomUUID();
    if (sessions.has(id) || pendingStarts.has(id)) {
      throw new Error(`Debug session '${id}' already exists`);
    }
    const info: DebugSessionInfo = {
      id,
      parentSessionId: parentSession?.info.id,
      name: request.configuration.name,
      debugType: request.configuration.type,
      request: request.configuration.request,
      status: "initializing",
      capabilities: {},
    };
    const pendingStart: PendingDebugStart = {
      info,
      controller: new AbortController(),
    };
    pendingStarts.set(id, pendingStart);
    const signal = pendingStart.controller.signal;

    let transport: DebugTransport | undefined;
    let session: DebugSession | undefined;
    try {
      const descriptor =
        adapterOverride ?? (await resolveAdapter(ctx, request.configuration));
      if (signal.aborted) throw new Error("Debug session start cancelled");
      const dapType = request.configuration.adapter || adapterOverride
        ? request.configuration.type
        : builtInDapType(request.configuration.type);
      if (descriptor.type === "executable") {
        transport = await openExecutable(descriptor, signal);
      } else if (descriptor.type === "executable-server") {
        transport = await openExecutableServer(descriptor, signal);
      } else {
        if (
          !Number.isInteger(descriptor.port) ||
          descriptor.port <= 0 ||
          descriptor.port > 65_535
        ) {
          throw new Error("Debug adapter server port is invalid");
        }
        const socket = await connectWithCancellation(
          descriptor.port,
          descriptor.host ?? "127.0.0.1",
          undefined,
          signal,
        );
        transport = {
          socket,
          connection: new DapConnection(socket, socket),
          endpoint: {
            host: descriptor.host ?? "127.0.0.1",
            port: descriptor.port,
          },
        };
      }
      pendingStart.transport = transport;
      if (signal.aborted) throw new Error("Debug session start cancelled");

      const activeSession: DebugSession = {
        info,
        configuration: request.configuration,
        dapType,
        connection: transport.connection,
        adapterProcess: transport.adapterProcess,
        adapterEndpoint: transport.endpoint,
        adapterOutputFromStdout: descriptor.type === "executable-server",
        socket: transport.socket,
        terminalProcesses: new Set(),
        terminalIds: new Set(),
        breakpoints: new Map(Object.entries(request.initialBreakpoints ?? {})),
        breakpointVersions: new Map(),
        exceptionBreakpoints: request.exceptionBreakpoints ?? [],
        readyForBreakpoints: false,
        configurationStarted: false,
        executionEventCounter: 0,
        startController: pendingStart.controller,
        userStopRequested: false,
        disposed: false,
      };
      session = activeSession;
      sessions.set(id, activeSession);
      pendingStarts.delete(id);
      publishSession(activeSession);
      activeSession.connection.onEvent((event) =>
        handleEvent(activeSession, event),
      );
      activeSession.connection.onRequest((reverseRequest) =>
        handleReverseRequest(activeSession, reverseRequest),
      );
      activeSession.connection.onError((error) =>
        failSession(activeSession, error),
      );
      activeSession.adapterProcess?.stderr.on("data", (data: Buffer | string) => {
        ctx.send(CH.debugEvent, {
          kind: "adapter-output",
          sessionId: id,
          category: "stderr",
          output: data.toString(),
        });
      });
      if (activeSession.adapterOutputFromStdout) {
        activeSession.adapterProcess?.stdout.on(
          "data",
          (data: Buffer | string) => {
            ctx.send(CH.debugEvent, {
              kind: "adapter-output",
              sessionId: id,
              category: "stdout",
              output: data.toString(),
            });
          },
        );
      }
      activeSession.adapterProcess?.once("exit", (code, signal) => {
        if (activeSession.disposed) return;
        const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        failSession(activeSession, new Error(`Debug adapter exited with ${suffix}`));
      });
      activeSession.adapterProcess?.once("error", (error) =>
        failSession(activeSession, error),
      );

      const initialize =
        await activeSession.connection.sendRequest<DapCapabilities>(
          "initialize",
          {
            clientID: "logos",
            clientName: "Logos",
            adapterID: activeSession.dapType,
            locale: "en-US",
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: "path",
            supportsVariableType: true,
            supportsVariablePaging: true,
            supportsRunInTerminalRequest: true,
            supportsStartDebuggingRequest: Boolean(activeSession.adapterEndpoint),
            supportsArgsCanBeInterpretedByShell: true,
          },
          30_000,
        );
      ensureSessionStarting(activeSession);
      activeSession.info = {
        ...activeSession.info,
        status: "starting",
        capabilities: initialize.body ?? {},
      };
      publishSession(activeSession);
      armInitializationTimer(activeSession);
      const launchOrAttach = await activeSession.connection.sendRequest(
        request.configuration.request,
        configurationArguments(request.configuration, activeSession.dapType),
        60_000,
      );
      ensureSessionStarting(activeSession);
      const additionalCapabilities = asArguments(launchOrAttach.body);
      if (Object.keys(additionalCapabilities).length) {
        activeSession.info = {
          ...activeSession.info,
          capabilities: {
            ...activeSession.info.capabilities,
            ...additionalCapabilities,
          },
        };
        publishSession(activeSession);
      }
      if (
        activeSession.info.status === "starting" &&
        activeSession.configurationStarted
      ) {
        setStatus(activeSession, "running");
      }
      if (rendererConfiguration) {
        if (!activeSession.adapterEndpoint) {
          throw new Error(
            "Electron renderer debugging requires a reusable debug adapter endpoint",
          );
        }
        await startSession(
          {
            configuration: rendererConfiguration,
            initialBreakpoints: Object.fromEntries(activeSession.breakpoints),
            exceptionBreakpoints: activeSession.exceptionBreakpoints,
          },
          { type: "server", ...activeSession.adapterEndpoint },
          activeSession,
        );
        ensureSessionStarting(activeSession);
      }
      return cloneInfo(activeSession);
    } catch (error) {
      const cancelled =
        signal.aborted ||
        session?.info.status === "terminating" ||
        session?.info.status === "terminated";
      if (session && !session.disposed) {
        if (cancelled) {
          if (session.shutdownPromise) {
            await session.shutdownPromise;
          } else {
            setStatus(session, "terminated");
            cleanupSession(session);
          }
        } else {
          failSession(session, error);
        }
      } else if (!session) {
        disposeTransport(transport);
      }
      if (cancelled) {
        return session
          ? cloneInfo(session)
          : { ...info, status: "terminated", message: undefined };
      }
      if (session) throw error;
      const failed: DebugSessionInfo = {
        ...info,
        status: "error",
        message: errorMessage(error),
      };
      ctx.send(CH.debugEvent, { kind: "session", session: failed });
      throw error;
    } finally {
      pendingStarts.delete(id);
    }
  };

  stopSession = (
    session: DebugSession,
    terminateDebuggee: boolean,
    sendTerminate = true,
    restart = false,
  ): Promise<void> => {
    if (sendTerminate) session.userStopRequested = true;
    if (session.shutdownPromise) return session.shutdownPromise;
    session.startController.abort();
    const shutdown = (async () => {
      if (
        session.info.status !== "terminated" &&
        session.info.status !== "error"
      ) {
        setStatus(session, "terminating");
      }
      session.connection.cancelPendingRequests(
        undefined,
        session.info.capabilities.supportsCancelRequest === true,
      );

      for (const pendingStart of pendingStarts.values()) {
        if (pendingStart.info.parentSessionId === session.info.id) {
          cancelPendingStart(pendingStart);
        }
      }
      const children = Array.from(sessions.values()).filter(
        (child) => child.info.parentSessionId === session.info.id,
      );
      if (children.length) {
        await Promise.all(
          children.map((child) => {
            child.userStopRequested = true;
            return stopSession(
              child,
              child.info.request === "launch",
              sendTerminate,
              restart,
            );
          }),
        );
      }

      if (
        sendTerminate &&
        terminateDebuggee &&
        session.info.request === "launch" &&
        session.info.capabilities.supportsTerminateRequest
      ) {
        try {
          await session.connection.sendRequest("terminate", {}, 2_000);
        } catch {
          // A failed graceful terminate must not prevent disconnect.
        }
      }

      try {
        const disconnectArguments: DapArguments = {};
        if (restart) disconnectArguments.restart = true;
        if (session.info.capabilities.supportTerminateDebuggee) {
          disconnectArguments.terminateDebuggee = terminateDebuggee;
        }
        await session.connection.sendRequest(
          "disconnect",
          disconnectArguments,
          2_000,
        );
      } catch {
        // The adapter often exits before acknowledging disconnect.
      } finally {
        if (!session.disposed) {
          setStatus(session, "terminated");
          cleanupSession(session, terminateDebuggee);
        }
      }
    })();
    session.shutdownPromise = shutdown;
    return shutdown;
  };

  ipcMain.handle(CH.debugList, () =>
    Array.from(sessions.values(), cloneInfo),
  );
  ipcMain.handle(CH.debugListAdapters, () => adapterInfo(ctx));
  ipcMain.handle(CH.debugStart, (_event, request: DebugStartRequest) =>
    startSession(request),
  );
  ipcMain.handle(
    CH.debugRequest,
    async (
      _event,
      sessionId: string,
      command: string,
      args?: DapArguments,
    ): Promise<DapResponse> => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Debug session '${sessionId}' is not running`);
      const executionEventCounter = session.executionEventCounter;
      const response = await session.connection.sendRequest(command, args, 30_000);
      if (
        (command === "continue" ||
          command === "next" ||
          command === "stepIn" ||
          command === "stepOut") &&
        !session.disposed &&
        session.executionEventCounter === executionEventCounter
      ) {
        const responseBody = asArguments(response.body);
        handleEvent(session, {
          seq: 0,
          type: "event",
          event: "continued",
          body: {
            threadId: typeof args?.threadId === "number" ? args.threadId : 0,
            allThreadsContinued:
              command === "continue"
                ? responseBody.allThreadsContinued !== false
                : args?.singleThread === true
                  ? false
                  : true,
          },
        });
      }
      return response;
    },
  );
  ipcMain.handle(
    CH.debugSetBreakpoints,
    (
      _event,
      sessionId: string,
      sourcePath: string,
      breakpoints: DapSourceBreakpoint[],
    ) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Debug session '${sessionId}' is not running`);
      return sendBreakpointsToSessionTree(session, sourcePath, breakpoints);
    },
  );
  ipcMain.handle(
    CH.debugStop,
    async (_event, sessionId: string, terminateDebuggee = true) => {
      const pendingStart = pendingStarts.get(sessionId);
      if (pendingStart) {
        cancelPendingStart(pendingStart);
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) return;
      await stopSession(session, terminateDebuggee);
    },
  );

  return () => {
    for (const pendingStart of pendingStarts.values()) {
      cancelPendingStart(pendingStart);
    }
    pendingStarts.clear();
    for (const session of sessions.values()) {
      setStatus(session, "terminated");
      cleanupSession(session);
    }
    sessions.clear();
  };
}
