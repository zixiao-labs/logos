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
      "setExceptionBreakpoints",
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

  it("starts a child session for the startDebugging reverse request", async () => {
    const ipc = createIpcHarness();
    const fake = fakeAdapterProcess();
    let sequence = 1;
    let rootSocket: ReturnType<typeof fakeDapSocket>;
    let childSocket: ReturnType<typeof fakeDapSocket>;
    let reverseResponse: DapMessage | undefined;

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
        current.send({
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
        request: "launch",
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
      debugType: "pwa-node",
      status: "running",
    });
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
