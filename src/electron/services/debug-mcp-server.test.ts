import { describe, expect, it } from "@lightning-js/lightning";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { debugMcpRegistryDirectory } from "./debug-mcp-bridge";

function connectProxy(): { client: Client; transport: StdioClientTransport } {
  return {
    client: new Client({ name: "logos-tests", version: "1.0.0" }),
    transport: new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve("packages/debug-mcp/server.mjs"),
        "--workspace",
        process.cwd(),
      ],
      cwd: process.cwd(),
      stderr: "ignore",
    }),
  };
}

/**
 * Answers the handshake, then accepts an execute and dies without replying —
 * the "Logos ran it but the answer never arrived" case the proxy must not
 * silently repeat.
 */
async function silentBridge(): Promise<{
  executed: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const token = randomBytes(32).toString("hex");
  const executed: Array<Record<string, unknown>> = [];
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline)) as {
        type?: string;
        token?: string;
        input?: Record<string, unknown>;
      };
      if (message.token !== token) {
        socket.end(
          `${JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } })}\n`,
        );
        return;
      }
      if (message.type === "handshake") {
        socket.end(`${JSON.stringify({ ok: true, result: { protocolVersion: 1 } })}\n`);
        return;
      }
      executed.push(message.input ?? {});
      socket.destroy();
    });
  });
  await new Promise<void>(resolve => {
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  const directory = debugMcpRegistryDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  // Distinct from the real bridge's `<pid>.json` so the suites cannot collide.
  const file = path.join(directory, `${process.pid}0.json`);
  await fs.writeFile(
    file,
    `${JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      port: address.port,
      token,
      startedAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(file, 0o600);
  return {
    executed,
    async close() {
      await fs.rm(file, { force: true });
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe("debug MCP stdio server", () => {
  it("publishes the complete structured debugger tool surface", async () => {
    const { client, transport } = connectProxy();
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name).sort()).toEqual([
        "debug_list_configurations",
        "debug_list_sessions",
        "debug_start",
        "debug_stop",
        "debug_restart",
        "debug_continue",
        "debug_pause",
        "debug_step_over",
        "debug_step_in",
        "debug_step_out",
        "debug_set_breakpoints",
        "debug_threads",
        "debug_stack_trace",
        "debug_scopes",
        "debug_variables",
        "debug_evaluate",
        "debug_source",
        "debug_request",
      ].sort());
      expect(
        tools.find(tool => tool.name === "debug_list_sessions")?.annotations,
      ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      expect(
        tools.find(tool => tool.name === "debug_evaluate")?.annotations,
      ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    } finally {
      await client.close();
    }
  });

  it("does not resend a mutation whose outcome is unknown, but retries reads", async () => {
    const bridge = await silentBridge();
    const { client, transport } = connectProxy();
    try {
      await client.connect(transport);

      const evaluated = (await client.callTool({
        name: "debug_evaluate",
        arguments: { expression: "dropDatabase()" },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(evaluated.isError).toBe(true);
      expect(evaluated.content[0]?.text).toContain("may already have run");
      expect(bridge.executed).toEqual([
        { action: "evaluate", expression: "dropDatabase()" },
      ]);

      const inspected = (await client.callTool({
        name: "debug_variables",
        arguments: { variables_reference: 3 },
      })) as { isError?: boolean };
      expect(inspected.isError).toBe(true);
      // Read-only actions are idempotent, so rediscovery may replay them.
      expect(bridge.executed.filter(item => item.action === "variables")).toHaveLength(2);
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
