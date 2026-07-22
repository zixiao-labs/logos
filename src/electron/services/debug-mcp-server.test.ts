import { describe, expect, it } from "@lightning-js/lightning";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

describe("debug MCP stdio server", () => {
  it("publishes the complete structured debugger tool surface", async () => {
    const client = new Client({ name: "logos-tests", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve("packages/debug-mcp/server.mjs"),
        "--workspace",
        process.cwd(),
      ],
      cwd: process.cwd(),
      stderr: "ignore",
    });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual([
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
      ]);
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
});
