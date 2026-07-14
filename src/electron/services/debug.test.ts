import { describe, expect, it } from "@lightning-js/lightning";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import type { Socket } from "node:net";
import {
  type ChildProcessWithoutNullStreams,
  type spawn,
} from "node:child_process";
import { CH } from "../../shared/channels";
import type { DapMessage, DapRequest, DebugSessionInfo } from "../../shared/dap";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { DapMessageParser, encodeDapMessage } from "./dap-transport";
import { registerDebugService } from "./debug";

function fakeAdapterProcess() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 9001,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  return { proc, stdin, stdout, stderr, wasKilled: () => killed };
}

function fakeDapSocket(
  onMessage: (message: DapMessage) => void,
): { socket: Socket; send: (message: DapMessage) => void } {
  const parser = new DapMessageParser();
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      for (const message of parser.push(chunk)) onMessage(message);
      callback();
    },
  });
  return {
    socket: socket as unknown as Socket,
    send: (message) => socket.push(encodeDapMessage(message)),
  };
}

describe("debug service", () => {
  it("runs initialize/configure/launch and generic DAP requests", async () => {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    const fake = fakeAdapterProcess();
    const parser = new DapMessageParser();
    let adapterSequence = 1;
    const receivedCommands: string[] = [];

    const send = (message: DapMessage) => fake.stdout.write(encodeDapMessage(message));
    const respond = (request: DapRequest, body?: unknown) =>
      send({
        seq: adapterSequence++,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: true,
        ...(body === undefined ? {} : { body }),
      });
    const reject = (request: DapRequest, message: string) =>
      send({
        seq: adapterSequence++,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: false,
        message,
      });
    fake.stdin.on("data", (data: Buffer) => {
      for (const message of parser.push(data)) {
        if (message.type !== "request") continue;
        receivedCommands.push(message.command);
        if (message.command === "initialize") {
          respond(message, {
            supportsConfigurationDoneRequest: true,
            supportsTerminateRequest: true,
          });
        } else if (message.command === "launch") {
          send({ seq: adapterSequence++, type: "event", event: "initialized" });
          respond(message);
        } else if (message.command === "setBreakpoints") {
          respond(message, {
            breakpoints: [{ verified: true, line: 7 }],
          });
        } else if (message.command === "threads") {
          respond(message, { threads: [{ id: 1, name: "main" }] });
        } else if (message.command === "terminate") {
          reject(message, "graceful termination failed");
        } else {
          respond(message);
        }
      }
    });

    const spawnProcess = (() => {
      queueMicrotask(() => fake.proc.emit("spawn"));
      return fake.proc;
    }) as unknown as typeof spawn;
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: (channel, ...args) => sent.push([channel, ...args]),
      } satisfies ServiceContext,
      { spawnProcess },
    );

    const session = await ipc.invoke<DebugSessionInfo>(CH.debugStart, {
      sessionId: "debug-1",
      configuration: {
        name: "Test",
        type: "custom",
        request: "launch",
        program: "/workspace/app.js",
        adapter: { type: "executable", command: "mock-adapter" },
      },
      initialBreakpoints: { "/workspace/app.js": [{ line: 7 }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session).toMatchObject({
      id: "debug-1",
      status: "running",
      capabilities: {
        supportsConfigurationDoneRequest: true,
        supportsTerminateRequest: true,
      },
    });
    expect(receivedCommands).toEqual([
      "initialize",
      "launch",
      "setBreakpoints",
      "configurationDone",
    ]);

    const threads = await ipc.invoke(CH.debugRequest, "debug-1", "threads");
    expect(threads).toMatchObject({ body: { threads: [{ id: 1, name: "main" }] } });
    const breakpoints = await ipc.invoke(
      CH.debugSetBreakpoints,
      "debug-1",
      "/workspace/app.js",
      [{ line: 7 }],
    );
    expect(breakpoints).toEqual([{ verified: true, line: 7 }]);
    expect(sent.some(([channel]) => channel === CH.debugEvent)).toBe(true);

    await ipc.invoke(CH.debugStop, "debug-1", true);
    expect(receivedCommands.slice(-2)).toEqual(["terminate", "disconnect"]);
    expect(fake.wasKilled()).toBe(true);
    cleanup();
  });

  it("does not launch after stop wins the initialize race", async () => {
    const ipc = createIpcHarness();
    let sequence = 1;
    let initializeRequest: DapRequest | undefined;
    let initializeSeen!: () => void;
    const sawInitialize = new Promise<void>((resolve) => {
      initializeSeen = resolve;
    });
    const commands: string[] = [];
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type !== "request") return;
      commands.push(message.command);
      if (message.command === "initialize") {
        initializeRequest = message;
        initializeSeen();
        return;
      }
      if (message.command === "disconnect") {
        if (initializeRequest) {
          adapter.send({
            seq: sequence++,
            type: "response",
            request_seq: initializeRequest.seq,
            command: initializeRequest.command,
            success: true,
          });
        }
        adapter.send({
          seq: sequence++,
          type: "response",
          request_seq: message.seq,
          command: message.command,
          success: true,
        });
      }
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      { connectSocket: async () => adapter.socket },
    );

    const start = ipc.invoke<DebugSessionInfo>(CH.debugStart, {
      sessionId: "initialize-race",
      configuration: {
        name: "Initialize race",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47124 },
      },
    });
    await sawInitialize;
    await ipc.invoke(CH.debugStop, "initialize-race", true);

    expect(await start).toMatchObject({ status: "terminated" });
    expect(commands).toEqual(["initialize", "disconnect"]);
    expect(await ipc.invoke(CH.debugList)).toEqual([]);
    cleanup();
  });

  it("finishes configuration when a breakpoint request fails", async () => {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    let sequence = 1;
    const commands: string[] = [];
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type !== "request") return;
      commands.push(message.command);
      adapter.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: message.command !== "setBreakpoints",
        ...(message.command === "initialize"
          ? { body: { supportsConfigurationDoneRequest: true } }
          : {}),
        ...(message.command === "setBreakpoints"
          ? { message: "invalid breakpoint" }
          : {}),
      });
      if (message.command === "launch") {
        adapter.send({ seq: sequence++, type: "event", event: "initialized" });
      }
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: (channel, ...args) => sent.push([channel, ...args]),
      } satisfies ServiceContext,
      { connectSocket: async () => adapter.socket },
    );

    const session = await ipc.invoke<DebugSessionInfo>(CH.debugStart, {
      sessionId: "breakpoint-failure",
      configuration: {
        name: "Breakpoint failure",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47125 },
      },
      initialBreakpoints: { "/workspace/app.js": [{ line: 7 }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.status).toBe("running");
    expect(commands).toEqual([
      "initialize",
      "launch",
      "setBreakpoints",
      "configurationDone",
    ]);
    expect(
      sent.some(
        ([, event]) =>
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          event.kind === "adapter-output",
      ),
    ).toBe(true);
    cleanup();
  });

  it("restarts a session with terminated restart data", async () => {
    const ipc = createIpcHarness();
    let sequence = 1;
    const launchArguments: unknown[] = [];
    const createAdapter = () => {
      let adapter: ReturnType<typeof fakeDapSocket>;
      adapter = fakeDapSocket((message) => {
        if (message.type !== "request") return;
        adapter.send({
          seq: sequence++,
          type: "response",
          request_seq: message.seq,
          command: message.command,
          success: true,
          ...(message.command === "initialize"
            ? {
                body: {
                  supportsConfigurationDoneRequest: true,
                  supportTerminateDebuggee: true,
                },
              }
            : {}),
        });
        if (message.command === "launch") {
          launchArguments.push(message.arguments);
          adapter.send({ seq: sequence++, type: "event", event: "initialized" });
        }
      });
      return adapter;
    };
    const first = createAdapter();
    const second = createAdapter();
    const sockets = [first.socket, second.socket];
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      {
        connectSocket: async () => {
          const socket = sockets.shift();
          if (!socket) throw new Error("Unexpected adapter connection");
          return socket;
        },
      },
    );

    await ipc.invoke(CH.debugStart, {
      sessionId: "restart-session",
      configuration: {
        name: "Restart",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47126 },
      },
    });
    first.send({
      seq: sequence++,
      type: "event",
      event: "terminated",
      body: { restart: { token: "restart-token" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(launchArguments).toHaveLength(2);
    expect(launchArguments[1]).toMatchObject({
      __restart: { token: "restart-token" },
    });
    expect(await ipc.invoke(CH.debugList)).toMatchObject([
      { id: "restart-session", status: "running" },
    ]);
    cleanup();
  });

  it("does not restart when terminated restart races with user stop", async () => {
    const ipc = createIpcHarness();
    let sequence = 1;
    let connections = 0;
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type !== "request") return;
      if (message.command === "terminate") {
        adapter.send({
          seq: sequence++,
          type: "event",
          event: "terminated",
          body: { restart: true },
        });
      }
      adapter.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: true,
        ...(message.command === "initialize"
          ? {
              body: {
                supportsConfigurationDoneRequest: true,
                supportsTerminateRequest: true,
                supportTerminateDebuggee: true,
              },
            }
          : {}),
      });
      if (message.command === "launch") {
        adapter.send({ seq: sequence++, type: "event", event: "initialized" });
      }
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      {
        connectSocket: async () => {
          connections++;
          return adapter.socket;
        },
      },
    );

    await ipc.invoke(CH.debugStart, {
      sessionId: "stop-restart-race",
      configuration: {
        name: "Stop restart race",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47128 },
      },
    });
    await ipc.invoke(CH.debugStop, "stop-restart-race", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connections).toBe(1);
    expect(await ipc.invoke(CH.debugList)).toEqual([]);
    cleanup();
  });

  it("does not restart when user stop follows a restart event", async () => {
    const ipc = createIpcHarness();
    let sequence = 1;
    let connections = 0;
    let disconnectRequest: DapRequest | undefined;
    let disconnectSeen!: () => void;
    const sawDisconnect = new Promise<void>((resolve) => {
      disconnectSeen = resolve;
    });
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type !== "request") return;
      if (message.command === "disconnect") {
        disconnectRequest = message;
        disconnectSeen();
        return;
      }
      adapter.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: true,
        ...(message.command === "initialize"
          ? {
              body: {
                supportsConfigurationDoneRequest: true,
                supportTerminateDebuggee: true,
              },
            }
          : {}),
      });
      if (message.command === "launch") {
        adapter.send({ seq: sequence++, type: "event", event: "initialized" });
      }
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      {
        connectSocket: async () => {
          connections++;
          return adapter.socket;
        },
      },
    );
    await ipc.invoke(CH.debugStart, {
      sessionId: "restart-stop-race",
      configuration: {
        name: "Restart then stop",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47130 },
      },
    });
    adapter.send({
      seq: sequence++,
      type: "event",
      event: "terminated",
      body: { restart: true },
    });
    await sawDisconnect;
    const stop = ipc.invoke(CH.debugStop, "restart-stop-race", true);
    adapter.send({
      seq: sequence++,
      type: "response",
      request_seq: disconnectRequest!.seq,
      command: "disconnect",
      success: true,
    });
    await stop;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connections).toBe(1);
    expect(await ipc.invoke(CH.debugList)).toEqual([]);
    cleanup();
  });

  it("synthesizes continued when a stepping adapter omits it", async () => {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    let sequence = 1;
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type !== "request") return;
      adapter.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: true,
        ...(message.command === "initialize"
          ? { body: { supportsConfigurationDoneRequest: true } }
          : {}),
      });
      if (message.command === "launch") {
        adapter.send({ seq: sequence++, type: "event", event: "initialized" });
      }
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: (channel, ...args) => sent.push([channel, ...args]),
      } satisfies ServiceContext,
      { connectSocket: async () => adapter.socket },
    );
    await ipc.invoke(CH.debugStart, {
      sessionId: "step-session",
      configuration: {
        name: "Step",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47129 },
      },
    });
    adapter.send({
      seq: sequence++,
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 1 },
    });

    await ipc.invoke(CH.debugRequest, "step-session", "next", { threadId: 1 });

    expect(await ipc.invoke(CH.debugList)).toMatchObject([
      { id: "step-session", status: "running" },
    ]);
    expect(
      sent.some(
        ([, event]) =>
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          event.kind === "dap" &&
          "event" in event &&
          typeof event.event === "object" &&
          event.event !== null &&
          "event" in event.event &&
          event.event.event === "continued",
      ),
    ).toBe(true);
    cleanup();
  });

  it("runs reverse terminal requests in the managed PTY", async () => {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    let sequence = 1;
    let reverseResponse: DapMessage | undefined;
    let terminalOptions: unknown;
    const killedTerminals: string[] = [];
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type === "response") {
        if (message.command === "runInTerminal") reverseResponse = message;
        return;
      }
      if (message.type !== "request") return;
      adapter.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: true,
        ...(message.command === "initialize"
          ? { body: { supportsConfigurationDoneRequest: true } }
          : {}),
      });
      if (message.command === "launch") {
        adapter.send({ seq: sequence++, type: "event", event: "initialized" });
      }
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: (channel, ...args) => sent.push([channel, ...args]),
        terminal: {
          create: (options) => {
            terminalOptions = options;
            return { id: "term-debug", pid: 4242, shell: "node" };
          },
          kill: (id) => killedTerminals.push(id),
        },
      } satisfies ServiceContext,
      { connectSocket: async () => adapter.socket },
    );
    await ipc.invoke(CH.debugStart, {
      sessionId: "terminal-session",
      configuration: {
        name: "Terminal",
        type: "custom",
        request: "launch",
        adapter: { type: "server", host: "127.0.0.1", port: 47127 },
      },
    });

    adapter.send({
      seq: sequence++,
      type: "request",
      command: "runInTerminal",
      arguments: {
        kind: "integrated",
        title: "Debug process",
        cwd: "/workspace",
        args: ["node", "app.js", "two words"],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminalOptions).toMatchObject({
      cwd: "/workspace",
      executable: "node",
      args: ["app.js", "two words"],
    });
    expect(reverseResponse).toMatchObject({
      success: true,
      body: { processId: 4242 },
    });
    expect(
      sent.some(
        ([, event]) =>
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          event.kind === "terminal",
      ),
    ).toBe(true);
    cleanup();
    expect(killedTerminals).toEqual(["term-debug"]);
  });

  it("starts a child session for the startDebugging reverse request", async () => {
    const ipc = createIpcHarness();
    const fake = fakeAdapterProcess();
    let sequence = 1;
    let rootSocket: ReturnType<typeof fakeDapSocket>;
    let childSocket: ReturnType<typeof fakeDapSocket>;
    let reverseResponse: DapMessage | undefined;
    const rootCommands: string[] = [];
    const childCommands: string[] = [];
    let childDisconnectArguments: unknown;

    const createSocket = (isRoot: boolean) => {
      let current: ReturnType<typeof fakeDapSocket>;
      current = fakeDapSocket((message) => {
        if (message.type === "response") {
          if (isRoot && message.command === "startDebugging") {
            reverseResponse = message;
          }
          return;
        }
        if (message.type !== "request") return;
        (isRoot ? rootCommands : childCommands).push(message.command);
        if (!isRoot && message.command === "disconnect") {
          childDisconnectArguments = message.arguments;
        }
        current.send({
          seq: sequence++,
          type: "response",
          request_seq: message.seq,
          command: message.command,
          success: true,
          ...(message.command === "initialize"
            ? {
                body: {
                  supportsConfigurationDoneRequest: true,
                  supportTerminateDebuggee: true,
                },
              }
            : {}),
        });
        if (message.command === "launch" || message.command === "attach") {
          current.send({ seq: sequence++, type: "event", event: "initialized" });
        }
      });
      return current;
    };
    rootSocket = createSocket(true);
    childSocket = createSocket(false);
    const sockets = [rootSocket.socket, childSocket.socket];
    const spawnProcess = (() => {
      queueMicrotask(() => fake.proc.emit("spawn"));
      return fake.proc;
    }) as unknown as typeof spawn;
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      {
        spawnProcess,
        connectSocket: async () => {
          const socket = sockets.shift();
          if (!socket) throw new Error("Unexpected adapter connection");
          return socket;
        },
      },
    );

    await ipc.invoke(CH.debugStart, {
      sessionId: "root-session",
      configuration: {
        name: "Root",
        type: "custom",
        request: "launch",
        adapter: {
          type: "executable-server",
          command: "mock-adapter",
          args: ["server.js", "${port}"],
          port: 47120,
        },
      },
    });
    rootSocket.send({
      seq: sequence++,
      type: "request",
      command: "startDebugging",
      arguments: {
        request: "attach",
        configuration: {
          name: "Worker",
          type: "pwa-node",
          __pendingTargetId: "target-1",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reverseResponse).toMatchObject({
      type: "response",
      command: "startDebugging",
      success: true,
    });
    const sessions = await ipc.invoke<DebugSessionInfo[]>(CH.debugList);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.name === "Worker")).toMatchObject({
      parentSessionId: "root-session",
      debugType: "custom",
      request: "attach",
      status: "running",
    });
    await ipc.invoke(CH.debugStop, "root-session", true);
    expect(rootCommands).toContain("disconnect");
    expect(childCommands).toContain("disconnect");
    expect(childDisconnectArguments).toMatchObject({ terminateDebuggee: false });
    expect(await ipc.invoke(CH.debugList)).toEqual([]);
    cleanup();
  });

  it("cancels a session while its adapter connection is opening", async () => {
    const ipc = createIpcHarness();
    let resolveSocket!: (socket: Socket) => void;
    const socketPromise = new Promise<Socket>((resolve) => {
      resolveSocket = resolve;
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      { connectSocket: () => socketPromise },
    );

    const start = ipc.invoke<DebugSessionInfo>(CH.debugStart, {
      sessionId: "cancelled-session",
      configuration: {
        name: "Cancelled",
        type: "custom",
        request: "attach",
        adapter: { type: "server", host: "127.0.0.1", port: 47121 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ipc.invoke(CH.debugStop, "cancelled-session", true);
    expect(await start).toMatchObject({ status: "terminated" });

    const socket = new PassThrough() as unknown as Socket;
    resolveSocket(socket);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.destroyed).toBe(true);
    expect(await ipc.invoke(CH.debugList)).toEqual([]);
    cleanup();
  });

  it("removes a direct-server session when initialization fails", async () => {
    const ipc = createIpcHarness();
    let sequence = 1;
    let adapter: ReturnType<typeof fakeDapSocket>;
    adapter = fakeDapSocket((message) => {
      if (message.type !== "request" || message.command !== "initialize") return;
      adapter.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: false,
        message: "initialize rejected",
      });
    });
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      { connectSocket: async () => adapter.socket },
    );

    await expect(
      ipc.invoke(CH.debugStart, {
        sessionId: "failed-session",
        configuration: {
          name: "Failed",
          type: "custom",
          request: "attach",
          adapter: { type: "server", host: "127.0.0.1", port: 47122 },
        },
      }),
    ).rejects.toThrow("initialize rejected");
    expect(await ipc.invoke(CH.debugList)).toEqual([]);
    expect(adapter.socket.destroyed).toBe(true);
    cleanup();
  });

  it("cancels an opening child session when its parent stops", async () => {
    const ipc = createIpcHarness();
    const fake = fakeAdapterProcess();
    let sequence = 1;
    let rootSocket: ReturnType<typeof fakeDapSocket>;
    rootSocket = fakeDapSocket((message) => {
      if (message.type !== "request") return;
      rootSocket.send({
        seq: sequence++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: true,
      });
      if (message.command === "launch") {
        rootSocket.send({ seq: sequence++, type: "event", event: "initialized" });
      }
    });
    const spawnProcess = (() => {
      queueMicrotask(() => fake.proc.emit("spawn"));
      return fake.proc;
    }) as unknown as typeof spawn;
    let resolveChildSocket!: (socket: Socket) => void;
    let childConnectionStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      childConnectionStarted = resolve;
    });
    const childSocketPromise = new Promise<Socket>((resolve) => {
      resolveChildSocket = resolve;
    });
    let connectionCount = 0;
    const cleanup = registerDebugService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp/logos-test",
        getWindow: () => null,
        send: () => undefined,
      } satisfies ServiceContext,
      {
        spawnProcess,
        connectSocket: () => {
          connectionCount++;
          if (connectionCount === 1) return Promise.resolve(rootSocket.socket);
          childConnectionStarted();
          return childSocketPromise;
        },
      },
    );

    await ipc.invoke(CH.debugStart, {
      sessionId: "parent-session",
      configuration: {
        name: "Parent",
        type: "custom",
        request: "launch",
        adapter: {
          type: "executable-server",
          command: "mock-adapter",
          port: 47123,
        },
      },
    });
    rootSocket.send({
      seq: sequence++,
      type: "request",
      command: "startDebugging",
      arguments: {
        request: "launch",
        configuration: { name: "Child", type: "custom" },
      },
    });
    await childStarted;
    await ipc.invoke(CH.debugStop, "parent-session", true);
    expect(await ipc.invoke(CH.debugList)).toEqual([]);

    const childSocket = new PassThrough() as unknown as Socket;
    resolveChildSocket(childSocket);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(childSocket.destroyed).toBe(true);
    cleanup();
  });
});
