# MCP project configuration

Logos reads project-scoped MCP servers from `<workspace>/.mcp.json`. The file is
plain JSON and is only read when an Agent lists or calls MCP tools. Reading the
file does not start a process or open a network connection.

## Supported `.mcp.json` shape

Use the common `mcpServers` form when sharing a configuration with Claude Code
or another client that follows that convention:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["tools/mcp-server.mjs"],
      "cwd": ".",
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Logos also accepts the VS Code-style top-level `servers` object. If both objects
exist, Logos merges them and lets `mcpServers` win for a duplicate server name.
This avoids hiding servers while a project is being migrated between clients.

A stdio server supports:

| Field | Required | Meaning |
| --- | --- | --- |
| `command` | Yes | Executable launched without a shell. |
| `args` | No | String arguments passed as separate argv entries. |
| `cwd` | No | Working directory, resolved inside the workspace. Defaults to the workspace root. |
| `env` | No | String environment overrides. Keep credentials out of committed files. |
| `disabled` | No | Set to `true` to ignore the entry. |

A Streamable HTTP server supports:

```json
{
  "mcpServers": {
    "remote-tools": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "X-Client": "logos"
      }
    }
  }
}
```

`type` may be `http` or `streamable-http`. Only `http:` and `https:` URLs are
accepted. Static `headers` are supported, but secrets should be supplied by a
client-specific credential mechanism instead of source control.

The file is limited to 1 MiB. A stdio `cwd` must resolve within the open
workspace, and a symlink cannot be used to escape it. Before Logos connects to a
server for `list_tools` or `call_tool`, the Agent permission surface shows the
transport details and asks for one-time approval. A config fingerprint prevents
a server command from changing between approval and execution.

## Logos debug MCP server

The `logos-debug` server lets an external Agent control the same DAP sessions as
the Logos Run and Debug UI:

```json
{
  "mcpServers": {
    "logos-debug": {
      "command": "node",
      "args": ["packages/debug-mcp/server.mjs", "--workspace", "."],
      "cwd": "."
    }
  }
}
```

Replace the server path when the MCP proxy is not stored in the workspace. The
automatic setup flow uses the MCP proxy bundled with the installed Logos app and
writes the canonical absolute workspace path, so that configuration is local to
the current machine. Regenerate it after moving the project to another machine,
or use a team-managed repo-relative command.

Keep Logos open on the same canonical workspace. The proxy discovers a private,
loopback-only bridge and does not start a second debugger. Read-only inspection
tools run directly. Every start, stop, restart, continue, pause, step,
breakpoint, evaluate, or raw DAP request opens a full-screen AlertDialog in
Logos. A system notification brings attention to the pending request; clicking
it focuses the approval dialog. Approval is one-time, expires after 60 seconds,
and is invalidated if the selected launch configuration or debug session changes.

## External Agent files

MCP clients use different project filenames. The server object is equivalent,
but the top-level container and file location are not universal:

| Client | Project file | Container |
| --- | --- | --- |
| Logos and Claude Code | `.mcp.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |
| VS Code / GitHub Copilot | `.vscode/mcp.json` | `servers` |
| Codex | `.codex/config.toml` | `[mcp_servers."logos-debug"]` |

VS Code stdio entries should set `"type": "stdio"`. A Codex equivalent is:

```toml
[mcp_servers."logos-debug"]
command = "node"
args = ["/absolute/path/to/server.mjs", "--workspace", "/absolute/workspace"]
cwd = "/absolute/workspace"
default_tools_approval_mode = "writes"
```

These locations follow the current client documentation for
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/mcp),
[Cursor](https://docs.cursor.com/context/model-context-protocol),
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
and [Codex](https://learn.chatgpt.com/docs/extend/mcp).

## Automatic setup when opening a folder

When a folder that is not already in **Recent** is selected with **Open Folder**,
Logos checks the four external MCP entries above and the open Agent Skills
location. If anything is missing, a dialog offers two independent options:

- **Configure MCP** adds only a missing `logos-debug` entry to `.mcp.json`,
  `.cursor/mcp.json`, `.vscode/mcp.json`, and `.codex/config.toml`.
- **Install Skill** copies `setup-launch-json` to
  `.agents/skills/setup-launch-json`, including its validator and compatibility
  reference.

Existing same-name server entries and existing Skill files are never
overwritten. Invalid JSON stops setup with an error instead of replacing the
file. Setup does not connect to an MCP server, run an Agent, or start a debug
process.
