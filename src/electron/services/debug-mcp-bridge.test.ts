import { afterEach, describe, expect, it, vi } from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DapArguments } from "../../shared/dap";
import type { ServiceContext } from "./context";
import {
  debugMcpRegistryDirectory,
  inspectDebugMcpRecord,
  registerDebugMcpBridge,
} from "./debug-mcp-bridge";
import { WorkspaceAccessController } from "./workspace-access";

function request(
  port: number,
  value: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

describe("debug MCP bridge", () => {
  let workspace = "";
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose?.();
    dispose = undefined;
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  it("publishes a private authenticated endpoint bound to the open workspace", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "logos-debug-mcp-test-"));
    const access = new WorkspaceAccessController();
    await access.restoreWorkspaceRoot(workspace);
    const configurationRoots: string[] = [];
    const debug: NonNullable<ServiceContext["debug"]> = {
      list: () => [],
      generation: () => undefined,
      start: async () => { throw new Error("not used"); },
      stop: async () => undefined,
      restart: async () => { throw new Error("not used"); },
      configurations: async root => {
        configurationRoots.push(root);
        return { path: null, configurations: [] };
      },
      startConfiguration: async () => { throw new Error("not used"); },
      setBreakpoints: async () => [],
      source: async () => { throw new Error("not used"); },
      request: async () => { throw new Error("not used"); },
    };
    dispose = await registerDebugMcpBridge({
      debug,
      workspaceAccess: access,
    } as ServiceContext);

    const recordPath = path.join(debugMcpRegistryDirectory(), `${process.pid}.json`);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
      token: string;
      port: number;
    };
    await expect(inspectDebugMcpRecord(recordPath)).resolves.toMatchObject({
      private: true,
      protocolVersion: 1,
      pid: process.pid,
      port: record.port,
    });
    await expect(request(record.port, {
      type: "handshake",
      token: "wrong",
      workspace,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    await expect(request(record.port, {
      type: "execute",
      token: record.token,
      workspace,
      input: { action: "list_sessions" },
    })).resolves.toEqual({ ok: true, result: [] });
    await expect(request(record.port, {
      type: "execute",
      token: record.token,
      workspace,
      input: { action: "list_configurations", workspace: path.dirname(workspace) },
    })).resolves.toMatchObject({ ok: true });
    expect(configurationRoots).toEqual([await fs.realpath(workspace)]);
  });

  it("requires one-time approval and validates the approved debug generation", async () => {
    const setTimeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "logos-debug-mcp-test-"));
    const access = new WorkspaceAccessController();
    await access.restoreWorkspaceRoot(workspace);
    const session = {
      id: "debug-1",
      name: "Node",
      debugType: "node",
      request: "launch" as const,
      status: "stopped" as const,
      capabilities: {},
    };
    let generation = "generation-1";
    let approvalMode: "allow" | "deny" | "change" = "deny";
    let pendingApproval: Promise<boolean> | undefined;
    let approvalStarted: (() => void) | undefined;
    const approvals: Array<Record<string, unknown>> = [];
    const requests: unknown[] = [];
    const starts: unknown[][] = [];
    const configuration = { name: "Node", type: "node", request: "launch" as const };
    const configurationPath = path.join(workspace, ".logos", "launch.json");
    const debug: NonNullable<ServiceContext["debug"]> = {
      list: () => [session],
      generation: () => generation,
      start: async () => session,
      stop: async () => undefined,
      restart: async () => session,
      configurations: async () => ({
        path: configurationPath,
        configurations: [configuration],
      }),
      startConfiguration: async (...args) => {
        starts.push(args);
        return session;
      },
      setBreakpoints: async () => [],
      source: async () => { throw new Error("not used"); },
      request: async <T = unknown>(
        sessionId: string,
        command: string,
        args?: DapArguments,
      ) => {
        requests.push({ sessionId, command, args });
        return {
          seq: 1,
          type: "response",
          request_seq: 1,
          success: true,
          command,
          body: { ok: true } as T,
        };
      },
    };
    dispose = await registerDebugMcpBridge(
      { debug, workspaceAccess: access } as ServiceContext,
      async details => {
        approvals.push(details);
        if (pendingApproval) {
          approvalStarted?.();
          return pendingApproval;
        }
        if (approvalMode === "change") generation = "generation-2";
        return approvalMode !== "deny";
      },
    );

    const recordPath = path.join(debugMcpRegistryDirectory(), `${process.pid}.json`);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
      token: string;
      port: number;
    };
    const execute = (input: Record<string, unknown>) => request(record.port, {
      type: "execute",
      token: record.token,
      workspace,
      input,
    });

    await expect(execute({ action: "evaluate", expression: "6 * 7" }))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "The debug action was not approved" },
      });
    expect(requests).toEqual([]);

    approvalMode = "allow";
    await expect(execute({ action: "evaluate", expression: "6 * 7" }))
      .resolves.toMatchObject({ ok: true });
    await expect(execute({ action: "start", configuration: "Node" }))
      .resolves.toMatchObject({ ok: true });
    expect(starts[0]?.[4]).toBe(JSON.stringify({
      path: configurationPath,
      configuration,
    }));

    approvalMode = "change";
    await expect(execute({ action: "pause" })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("changed after approval") },
    });
    expect(requests).toHaveLength(1);
    expect(approvals).toHaveLength(4);
    expect(approvals[1]).toMatchObject({
      action: "evaluate",
      session: { id: "debug-1" },
    });

    let resolveApproval: ((allowed: boolean) => void) | undefined;
    pendingApproval = new Promise(resolve => { resolveApproval = resolve; });
    const started = new Promise<void>(resolve => { approvalStarted = resolve; });
    const pendingResponse = execute({ action: "evaluate", expression: "1 + 1" });
    await started;
    expect(setTimeoutSpy.mock.calls.at(-1)?.[0]).toBe(0);
    resolveApproval?.(true);
    await expect(pendingResponse).resolves.toMatchObject({ ok: true });
    expect(setTimeoutSpy.mock.calls.at(-1)?.[0]).toBe(65_000);
    expect(requests).toHaveLength(2);

    pendingApproval = new Promise(resolve => { resolveApproval = resolve; });
    const disconnectedStarted = new Promise<void>(resolve => { approvalStarted = resolve; });
    const socket = net.createConnection({ host: "127.0.0.1", port: record.port });
    socket.on("connect", () => socket.write(`${JSON.stringify({
      type: "execute",
      token: record.token,
      workspace,
      input: { action: "evaluate", expression: "2 + 2" },
    })}\n`));
    await disconnectedStarted;
    const bridgeSocket = setTimeoutSpy.mock.contexts.at(-1) as net.Socket;
    const closed = new Promise<void>(resolve => bridgeSocket.once("close", resolve));
    bridgeSocket.destroy();
    await closed;
    socket.destroy();
    resolveApproval?.(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(2);
  });
});
