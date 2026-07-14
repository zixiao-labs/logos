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
  breakpoints: Map<string, DapSourceBreakpoint[]>;
  exceptionBreakpoints: string[];
  readyForBreakpoints: boolean;
  configurationStarted: boolean;
  disposed: boolean;
}

interface DebugServiceDependencies {
  spawnProcess: SpawnProcess;
  connectSocket(port: number, host: string): Promise<net.Socket>;
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
  return { ...dapConfiguration, type: dapType };
}

function mergeEnvironment(
  overrides: Record<string, string | null> | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value == null) delete result[key];
    else result[key] = value;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultConnectSocket(
  port: number,
  host: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
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
  return [
    path.join(process.cwd(), "build", "debug-adapters", "js-debug", "src", "dapDebugServer.js"),
    path.join(resourceRoot, "debug-adapters", "js-debug", "src", "dapDebugServer.js"),
    path.join(resourceRoot, "debug-adapters", "js-debug", "dist", "src", "dapDebugServer.js"),
    path.join(ctx.userDataDir, "debug-adapters", "js-debug", "src", "dapDebugServer.js"),
  ];
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
      ...(!jsDebug ? { message: "JavaScript debug adapter is not installed" } : {}),
    },
    {
      type: "chrome",
      label: "Chrome",
      builtIn: true,
      available: Boolean(jsDebug),
      ...(!jsDebug ? { message: "JavaScript debug adapter is not installed" } : {}),
    },
    {
      type: "electron",
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

  const cleanupSession = (session: DebugSession) => {
    if (session.disposed) return;
    session.disposed = true;
    for (const child of sessions.values()) {
      if (child.info.parentSessionId !== session.info.id) continue;
      if (child.info.status !== "terminated") setStatus(child, "terminated");
      cleanupSession(child);
    }
    session.connection.dispose();
    session.socket?.destroy();
    if (session.adapterProcess && !session.adapterProcess.killed) {
      session.adapterProcess.kill();
    }
    for (const child of session.terminalProcesses) {
      if (!child.killed) child.kill();
    }
    session.terminalProcesses.clear();
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
    });
    const result = response.body?.breakpoints ?? [];
    ctx.send(CH.debugEvent, {
      kind: "breakpoints",
      sessionId: session.info.id,
      sourcePath,
      breakpoints: result,
    });
    return result;
  };

  const configureSession = async (session: DebugSession) => {
    if (session.configurationStarted || session.disposed) return;
    session.configurationStarted = true;
    try {
      for (const [sourcePath, breakpoints] of session.breakpoints) {
        await sendBreakpoints(session, sourcePath, breakpoints);
      }
      await session.connection.sendRequest("setExceptionBreakpoints", {
        filters: session.exceptionBreakpoints,
      });
      if (session.info.capabilities.supportsConfigurationDoneRequest) {
        await session.connection.sendRequest("configurationDone");
      }
      if (session.info.status === "starting") setStatus(session, "running");
    } catch (error) {
      failSession(session, error);
    }
  };

  const handleEvent = (session: DebugSession, event: DapEvent) => {
    if (session.disposed) return;
    if (event.event === "initialized") {
      session.readyForBreakpoints = true;
      void configureSession(session);
    } else if (event.event === "stopped") {
      setStatus(session, "stopped");
    } else if (event.event === "continued" || event.event === "process") {
      setStatus(session, "running");
    } else if (event.event === "terminated" || event.event === "exited") {
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
    if (event.event === "terminated" || event.event === "exited") {
      queueMicrotask(() => {
        if (session.disposed) return;
        void session.connection
          .sendRequest("disconnect", { terminateDebuggee: false }, 1_000)
          .catch(() => undefined)
          .finally(() => cleanupSession(session));
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
    const envOverrides =
      args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? (args.env as Record<string, string | null>)
        : undefined;
    try {
      const child = spawnProcess(commandLine[0], commandLine.slice(1), {
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        env: mergeEnvironment(envOverrides),
        shell: args.argsCanBeInterpretedByShell === true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
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
          ...(child.pid ? { processId: child.pid } : {}),
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
      type: parent.configuration.type,
      request: requestKind,
    };
    await startSession(
      {
        configuration: childConfiguration,
        initialBreakpoints: Object.fromEntries(parent.breakpoints),
        exceptionBreakpoints: parent.exceptionBreakpoints,
      },
      { type: "server", ...parent.adapterEndpoint },
      parent,
    );
  };

  const handleReverseRequest = (session: DebugSession, request: DapRequest) => {
    if (request.command === "runInTerminal") {
      runInTerminal(session, request);
      return;
    }
    if (request.command === "startDebugging") {
      void startChildSession(session, request).then(
        () => session.connection.sendResponse(request, true),
        (error) =>
          session.connection.sendResponse(
            request,
            false,
            undefined,
            errorMessage(error),
          ),
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

  const spawnAdapterProcess = async (descriptor: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string | null>;
  }): Promise<ChildProcessWithoutNullStreams> => {
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
    const child = spawnProcess(descriptor.command, descriptor.args ?? [], {
      cwd: descriptor.cwd,
      env: mergeEnvironment(descriptor.env),
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return child;
  };

  const openExecutable = async (
    descriptor: DebugAdapterExecutable,
  ): Promise<{
    connection: DapConnection;
    adapterProcess: ChildProcessWithoutNullStreams;
  }> => {
    const child = await spawnAdapterProcess(descriptor);
    return {
      connection: new DapConnection(child.stdout, child.stdin),
      adapterProcess: child,
    };
  };

  const openExecutableServer = async (
    descriptor: DebugAdapterExecutableServer,
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
    const child = await spawnAdapterProcess({ ...descriptor, args });
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline && child.exitCode == null) {
      try {
        const socket = await connectSocket(port, host);
        return {
          socket,
          endpoint: { host, port },
          adapterProcess: child,
          connection: new DapConnection(socket, socket),
        };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    if (!child.killed) child.kill();
    throw new Error(
      `Unable to connect to debug adapter at ${host}:${port}: ${errorMessage(lastError)}`,
    );
  };

  startSession = async (
    request: DebugStartRequest,
    adapterOverride?: DebugAdapterDescriptor,
    parentSession?: DebugSession,
  ) => {
    const id = request.sessionId ?? randomUUID();
    if (sessions.has(id)) throw new Error(`Debug session '${id}' already exists`);
    const info: DebugSessionInfo = {
      id,
      parentSessionId: parentSession?.info.id,
      name: request.configuration.name,
      debugType: request.configuration.type,
      request: request.configuration.request,
      status: "initializing",
      capabilities: {},
    };

    let transport:
      | {
          connection: DapConnection;
          adapterProcess?: ChildProcessWithoutNullStreams;
          socket?: net.Socket;
          endpoint?: { host: string; port: number };
        }
      | undefined;
    try {
      const descriptor =
        adapterOverride ?? (await resolveAdapter(ctx, request.configuration));
      const dapType = request.configuration.adapter || adapterOverride
        ? request.configuration.type
        : builtInDapType(request.configuration.type);
      if (descriptor.type === "executable") {
        transport = await openExecutable(descriptor);
      } else if (descriptor.type === "executable-server") {
        transport = await openExecutableServer(descriptor);
      } else {
        if (!Number.isInteger(descriptor.port) || descriptor.port <= 0) {
          throw new Error("Debug adapter server port is invalid");
        }
        const socket = await connectSocket(
          descriptor.port,
          descriptor.host ?? "127.0.0.1",
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

      const session: DebugSession = {
        info,
        configuration: request.configuration,
        dapType,
        connection: transport.connection,
        adapterProcess: transport.adapterProcess,
        adapterEndpoint: transport.endpoint,
        adapterOutputFromStdout: descriptor.type === "executable-server",
        socket: transport.socket,
        terminalProcesses: new Set(),
        breakpoints: new Map(Object.entries(request.initialBreakpoints ?? {})),
        exceptionBreakpoints: request.exceptionBreakpoints ?? [],
        readyForBreakpoints: false,
        configurationStarted: false,
        disposed: false,
      };
      sessions.set(id, session);
      publishSession(session);
      session.connection.onEvent((event) => handleEvent(session, event));
      session.connection.onRequest((reverseRequest) =>
        handleReverseRequest(session, reverseRequest),
      );
      session.connection.onError((error) => failSession(session, error));
      session.adapterProcess?.stderr.on("data", (data: Buffer | string) => {
        ctx.send(CH.debugEvent, {
          kind: "adapter-output",
          sessionId: id,
          category: "stderr",
          output: data.toString(),
        });
      });
      if (session.adapterOutputFromStdout) {
        session.adapterProcess?.stdout.on("data", (data: Buffer | string) => {
          ctx.send(CH.debugEvent, {
            kind: "adapter-output",
            sessionId: id,
            category: "stdout",
            output: data.toString(),
          });
        });
      }
      session.adapterProcess?.once("exit", (code, signal) => {
        if (session.disposed) return;
        const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        failSession(session, new Error(`Debug adapter exited with ${suffix}`));
      });

      const initialize = await session.connection.sendRequest<DapCapabilities>(
        "initialize",
        {
          clientID: "logos",
          clientName: "Logos",
          adapterID: session.dapType,
          locale: "en-US",
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: "path",
          supportsVariableType: true,
          supportsVariablePaging: true,
          supportsRunInTerminalRequest: true,
          supportsStartDebuggingRequest: true,
          supportsMemoryReferences: true,
          supportsProgressReporting: true,
          supportsInvalidatedEvent: true,
          supportsMemoryEvent: true,
          supportsArgsCanBeInterpretedByShell: true,
          supportsANSIStyling: true,
        },
      );
      session.info = {
        ...session.info,
        status: "starting",
        capabilities: initialize.body ?? {},
      };
      publishSession(session);
      await session.connection.sendRequest(
        request.configuration.request,
        configurationArguments(request.configuration, session.dapType),
      );
      if (session.info.status === "starting" && session.configurationStarted) {
        setStatus(session, "running");
      }
      return cloneInfo(session);
    } catch (error) {
      transport?.connection.dispose();
      transport?.socket?.destroy();
      transport?.adapterProcess?.kill();
      const failed: DebugSessionInfo = {
        ...info,
        status: "error",
        message: errorMessage(error),
      };
      ctx.send(CH.debugEvent, { kind: "session", session: failed });
      throw error;
    }
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
      return session.connection.sendRequest(command, args);
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
      return sendBreakpoints(session, sourcePath, breakpoints);
    },
  );
  ipcMain.handle(
    CH.debugStop,
    async (_event, sessionId: string, terminateDebuggee = true) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      setStatus(session, "terminating");
      try {
        if (
          terminateDebuggee &&
          session.info.capabilities.supportsTerminateRequest
        ) {
          await session.connection.sendRequest("terminate", {}, 2_000);
        }
        await session.connection.sendRequest(
          "disconnect",
          { terminateDebuggee },
          2_000,
        );
      } catch {
        // The adapter often exits before acknowledging disconnect.
      } finally {
        setStatus(session, "terminated");
        cleanupSession(session);
      }
    },
  );

  return () => {
    for (const session of sessions.values()) {
      setStatus(session, "terminated");
      cleanupSession(session);
    }
    sessions.clear();
  };
}
