import { afterEach, describe, expect, it } from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
});
