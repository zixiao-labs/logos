import { afterEach, describe, expect, it } from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceMcpClient } from "./mcp-client";

describe("workspace MCP client configuration", () => {
  let temporary = "";

  afterEach(async () => {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  });

  it("merges mcpServers with VS Code servers and prefers common entries", async () => {
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "logos-mcp-config-")),
    );
    await fs.writeFile(
      path.join(temporary, ".mcp.json"),
      JSON.stringify({
        servers: {
          vscode: { command: "vscode-server" },
          duplicate: { command: "vscode-version" },
        },
        mcpServers: {
          common: { command: "common-server" },
          duplicate: { command: "common-version" },
        },
      }),
      "utf8",
    );
    const client = new WorkspaceMcpClient(temporary);

    const listed = await client.run({ action: "list_servers" });
    expect(listed.output.split("\n").sort()).toEqual([
      "common\tstdio",
      "duplicate\tstdio",
      "vscode\tstdio",
    ]);
    expect(
      await client.permissionDetails({ action: "list_tools", server: "duplicate" }),
    ).toMatchObject({
      details: { transport: { command: "common-version" } },
    });
    await client.close();
  });
});
