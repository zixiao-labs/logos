# Debugging with `launch.json`

Logos starts and controls debuggers through the Debug Adapter Protocol (DAP).
Use `launch.json` to describe how to launch a program or attach to one that is
already running.

> [!IMPORTANT]
> The format is deliberately close to VS Code's `launch.json`: it uses the same
> `version` and `configurations` structure, the same required
> `name`/`type`/`request` fields, JSON with comments, and a subset of VS Code's
> variables. Many Node.js and Chrome configurations can therefore be reused.
> It is not a complete VS Code implementation; check
> [VS Code compatibility](#vs-code-compatibility) before sharing a file.

## Configuration file

Logos loads the first file that exists in this order:

1. `<workspace>/.logos/launch.json`
2. `<workspace>/.vscode/launch.json`

Use `.logos/launch.json` for Logos-specific configuration. Use
`.vscode/launch.json` when the configuration only uses the shared subset and
must also work in VS Code. If both files exist, `.logos/launch.json` wins. An
invalid `.logos/launch.json` also prevents fallback to `.vscode/launch.json`.

The **Create launch.json** action creates `.vscode/launch.json` because the
default Node configuration uses the shared subset. After editing a configuration,
use **Reload Configurations** in the Debug sidebar to load the latest version.

The file accepts JSONC: `//` and `/* */` comments and trailing commas are
allowed. A minimal Node.js configuration is:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Node: Current File",
      "type": "node",
      "request": "launch",
      "program": "${file}",
      "cwd": "${workspaceFolder}",
      "console": "internalConsole"
    }
  ]
}
```

Open the file to debug before starting this example because `${file}` resolves
from the active editor.

## File fields

| Field | Required | Description |
| --- | --- | --- |
| `version` | Recommended | Use `"0.2.0"`. Logos currently accepts any string and defaults to `"0.2.0"` if it is absent. |
| `configurations` | Yes | Array of launch and attach configurations. |

Every configuration requires these fields:

| Field | Description |
| --- | --- |
| `name` | Display name shown in the Debug sidebar. Keep names unique. |
| `type` | Built-in debugger type or the type expected by a custom DAP adapter. |
| `request` | Either `"launch"` or `"attach"`. |

Fields such as `program`, `args`, `cwd`, `env`, `envFile`, `console`, `url`,
`webRoot`, `runtimeExecutable`, `runtimeArgs`, `skipFiles`, and `outFiles` are
defined and validated by the selected debug adapter, not by Logos. Consult that
adapter's documentation for the fields it accepts.

## Built-in JavaScript debugger

Logos packages Microsoft's JavaScript debugger for the following types:

| Type | Runtime and status |
| --- | --- |
| `node`, `pwa-node` | Node.js. |
| `chrome`, `pwa-chrome` | Chrome. |
| `electron` | Electron main process, with an optional Logos-managed renderer attach. This alias sends `pwa-node` to the adapter, so provide suitable `runtimeExecutable` and related js-debug options. |
| `pwa-extensionHost` | Recognized, but not currently supported end to end because Logos does not implement js-debug's `launchVSCode` reverse request. |

Logos sends `node` and `electron` to the adapter as `pwa-node`, and `chrome` as
`pwa-chrome`. The remaining configuration fields are passed to that adapter. As
a result, their syntax is close to Microsoft's VS Code JavaScript debugger
configuration, including common fields such as `program`, `runtimeExecutable`,
`url`, and `webRoot`. See the
[JavaScript debugger options](https://github.com/microsoft/vscode-js-debug/blob/main/OPTIONS.md)
for its field reference, while observing Logos' compatibility limits below.
Use `internalConsole` or `integratedTerminal` when setting `console`;
`externalTerminal` is not supported by Logos.

When Logos is started from a desktop launcher, it augments the debug adapter's
`PATH` with `NVM_BIN` and Node versions installed under `$NVM_DIR` or `~/.nvm`.
This allows values such as `"runtimeExecutable": "npm"` to work even though the
desktop process did not load the user's shell startup files.

For example, launch Chrome against a local development server:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Chrome: Local App",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:3000",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
```

The development server must already be running because Logos does not execute
`preLaunchTask`.

To debug an Electron main process and renderer together, expose a Chromium
remote-debugging port from Electron and add a Logos-specific `renderer` object:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Electron: Development",
      "type": "electron",
      "request": "launch",
      "runtimeExecutable": "npm",
      "runtimeArgs": [
        "run",
        "electron:dev",
        "--",
        "--remote-debugging-port=9222"
      ],
      "cwd": "${workspaceFolder}",
      "outputCapture": "std",
      "renderer": {
        "port": 9222,
        "webRoot": "${workspaceFolder}",
        "urlFilter": "*"
      }
    }
  ]
}
```

The `renderer.port` must match Electron's `--remote-debugging-port`. The `--`
in the example makes npm forward the switch to the script; the script must in
turn pass it to the Electron executable. Replace `electron:dev` with the
workspace's Electron launch script. For a direct Electron executable, put the
switch directly in `runtimeArgs`. Logos starts the renderer as a
`pwa-chrome` attach child of the main-process session, inherits the initial
breakpoints, and stops both sessions together. Other Chrome attach fields such
as `address`, `url`, `urlFilter`, `sourceMaps`, and `timeout` may be placed in
`renderer`; `port` is required.

## Custom DAP adapters

Any other debugger type must include Logos' `adapter` field. This field tells
Logos how to start or connect to the adapter and is removed before the launch or
attach request is sent to it.

### Executable over stdio

Use `executable` when the adapter exchanges DAP messages over stdin and stdout:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Custom: Launch",
      "type": "custom-debugger",
      "request": "launch",
      "program": "${workspaceFolder}/app",
      "adapter": {
        "type": "executable",
        "command": "custom-debug-adapter",
        "args": ["--stdio"],
        "cwd": "${workspaceFolder}",
        "env": {
          "LOG_LEVEL": "debug",
          "REMOVE_THIS_VARIABLE": null
        }
      }
    }
  ]
}
```

`command` is required. `args`, `cwd`, and `env` are optional. Adapter
environment variables inherit the Logos process environment; a string sets or
overrides a value and `null` removes it.

### Existing DAP server

Use `server` when the adapter is already listening on TCP:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Custom: Attach through DAP Server",
      "type": "custom-debugger",
      "request": "attach",
      "adapter": {
        "type": "server",
        "host": "127.0.0.1",
        "port": 4711
      }
    }
  ]
}
```

`port` is required and must be an integer from 1 through 65535. `host` defaults
to `127.0.0.1`.

### Executable that opens a DAP server

Use `executable-server` when Logos must first launch an adapter and then connect
to its TCP server:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Custom: Launch Adapter Server",
      "type": "custom-debugger",
      "request": "launch",
      "adapter": {
        "type": "executable-server",
        "command": "custom-debug-adapter",
        "args": ["--listen", "${host}:${port}"],
        "cwd": "${workspaceFolder}",
        "host": "127.0.0.1"
      }
    }
  ]
}
```

`command` is required. `args`, `cwd`, `env`, `host`, and `port` are optional.
When provided, `port` must be an integer from 1 through 65535; Logos allocates a
port when it is omitted. In `adapter.args`, `${host}` and `${port}` resolve to
the selected endpoint; if no argument contains `${port}`, Logos appends the port
as the final argument.

## Variables

Variables are resolved recursively in string values, arrays, and objects.

| Variable | Value |
| --- | --- |
| `${workspaceFolder}` | Current workspace root. |
| `${workspaceFolderBasename}` | Workspace directory name. |
| `${workspaceFolder:name}` | Workspace root when `name` exactly matches the current workspace directory name. Logos currently has a single workspace root. |
| `${file}` | Active file's absolute path. |
| `${fileBasename}` | Active file's name. |
| `${fileDirname}` | Active file's directory. |
| `${relativeFile}` | Active file relative to the workspace, or its original path when it is outside the workspace. |
| `${pathSeparator}` | Workspace path separator. |
| `${env:NAME}` | Environment variable, or an empty string if it is not defined. |

File variables resolve to an empty string when the active editor is not a
regular file. Unknown variables remain unchanged, except `${command:...}` and
`${input:...}`, which stop the debug launch with an unsupported-variable error.
The `${host}` and `${port}` variables are only special inside
`executable-server` adapter arguments.

## VS Code compatibility

Logos `launch.json` is close to VS Code's format, especially for Node.js and
Chrome because both use Microsoft's JavaScript debug adapter. A configuration
is a good candidate for sharing as `.vscode/launch.json` when it:

- uses `node`, `pwa-node`, `chrome`, or `pwa-chrome`;
- only uses adapter fields accepted by Microsoft `js-debug`;
- only uses variables listed above; and
- does not depend on VS Code editor orchestration.

The `electron` type is a Logos alias, not a shared VS Code type. For a shareable
Electron main-process configuration, use a valid `node` configuration with the
appropriate `runtimeExecutable` instead.

Important differences:

| Feature | Logos behavior |
| --- | --- |
| File location | Prefers `.logos/launch.json`; `.vscode/launch.json` is a fallback. |
| `adapter` | Logos-specific transport descriptor. Do not expect VS Code to start it. |
| Debugger types | Only the built-in JavaScript types are registered automatically. Other types need `adapter`. |
| `inputs`, `${input:...}`, `${command:...}` | Not supported. |
| `compounds` | Not supported. Start configurations separately. |
| `preLaunchTask`, `postDebugTask` | Logos does not run VS Code tasks for debug configurations. |
| `windows`, `linux`, `osx` overrides | Logos does not merge platform-specific sections. |
| `presentation`, `serverReadyAction` | VS Code editor features are not implemented by Logos. |
| `console: "externalTerminal"` | Not supported. Use `internalConsole` or `integratedTerminal`. |
| `pwa-extensionHost` | Registered, but extension-host launch is not supported end to end. |
| Schema and completion | Logos does not currently provide debugger-specific `launch.json` schema completion. |

Do not copy a VS Code configuration unchanged merely because its JSON shape is
accepted. Logos passes unknown per-configuration fields to the adapter, but
that does not implement VS Code's editor-level behavior. See the
[VS Code launch configuration documentation](https://code.visualstudio.com/docs/debugtest/debugging-configuration)
when comparing files.

## Agent and MCP control

The built-in Logos Agent exposes a structured `DAP` tool over the same sessions used by
the Run and Debug UI. It supports configuration/session discovery, launch, stop,
restart, continue, pause, step over/in/out, source breakpoints, threads, stack traces,
scopes, variables, source retrieval, evaluation, and advanced raw DAP requests.
Read-only inspection does not require approval; actions that can change the debuggee or
execute code require one-time approval.

Third-party Agents can connect through the standard stdio MCP server in
`packages/debug-mcp/server.mjs`. This repository's project-level `.mcp.json` registers
it as `logos-debug`:

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

The MCP process does not launch a second debugger. It discovers a running Logos window
with the same canonical workspace and forwards tools to that window's shared DAP
controller. The bridge listens only on loopback, uses a random token for every Logos
launch, and stores discovery data under `~/.logos/debug-mcp` with current-user-only
permissions. That location is deliberately not the temp directory: MCP clients spawn
servers with a scrubbed environment that keeps `HOME` but drops `TMPDIR`, so a
temp-based path would not resolve to the same directory on both sides. Keep Logos open
on the project before calling an MCP debug tool.

Read-only tools (`debug_list_configurations`, `debug_list_sessions`, `debug_threads`,
`debug_stack_trace`, `debug_scopes`, `debug_variables`, `debug_source`) run without a
prompt, so any process that can read the discovery file can inspect debuggee state.
`debug_source` resolves its `source_path` through the same workspace authority as
breakpoints, and raw `debug_request` refuses `source` and `setBreakpoints` so that
authority cannot be bypassed.

If Logos accepts a mutating request but its answer never arrives, the proxy reports
that the action may already have run instead of resending it — a silent retry could
start a second debuggee or evaluate an expression twice. Read-only tools are
idempotent and are retried normally.

Mutating external MCP requests open a non-dismissable, full-screen approval dialog
in Logos and post a system notification. The dialog exposes the complete action,
configuration, session, and argument details and requires **Allow once** or **Deny**.
An unanswered request is denied after 60 seconds.
See [MCP project configuration](../agents/mcp-json.md) for Claude, Cursor, VS Code,
and Codex project formats and the automatic folder setup flow.

## Launch configuration Setup Skill

The project Skill lives at `.agents/skills/setup-launch-json`, the open Agent Skills
repository location recognized by compatible external Agents. Invoke it as
`$setup-launch-json` to inspect the runtime and entry points,
select `.logos/launch.json` or the VS Code-compatible fallback without changing
precedence accidentally, create or repair configurations, and run deterministic
validation. Its validator can also be run directly:

```bash
node .agents/skills/setup-launch-json/scripts/validate-launch-json.mjs \
  --workspace /absolute/path/to/workspace
```

## Generate with AI

Paste the following prompt into the Logos agent or another coding agent. It
requires the agent to inspect the project instead of guessing commands and to
call out whether the result is close enough to VS Code's format to share.

```text
Create or update a DAP launch configuration for this workspace in Logos.

First inspect the workspace language, entry points, package/build scripts, and
existing .logos/launch.json or .vscode/launch.json. Determine whether the user
needs launch or attach. Ask a concise question if a required executable,
adapter command, entry point, or port cannot be established from the workspace;
do not invent one.

Follow these Logos rules:

1. Update .logos/launch.json when it already exists because Logos loads it first.
   Otherwise, if .vscode/launch.json exists, preserve and update that file when
   the new configuration uses the compatible subset. If a Logos-specific
   configuration is required instead, ask before creating .logos/launch.json;
   explain that it will take precedence, and migrate all configurations the
   user still needs so the existing .vscode entries do not disappear in Logos.
   If neither file exists, prefer .vscode/launch.json when the configuration uses
   the shared subset. Use .logos/launch.json for Logos-specific fields.
2. Generate one complete JSONC file with "version": "0.2.0" and a
   "configurations" array. Every configuration must have a unique string
   "name", a string "type", and "request" set to "launch" or "attach".
3. Use node or pwa-node for Node.js, and chrome or pwa-chrome for Chrome. Logos
   also supports electron as a Logos-specific alias for pwa-node when debugging
   an Electron main process; its runtimeExecutable and remaining options must be
   valid js-debug Node options. Do not generate pwa-extensionHost because Logos
   does not currently support its launch flow end to end. To share an Electron
   main-process configuration with VS Code, use type node with a suitable
   runtimeExecutable instead of the Logos-only electron alias.
4. For any other type, include a Logos-specific "adapter" descriptor:
   - executable: command and optional args, cwd, env
   - server: port and optional host
   - executable-server: command and optional args, cwd, env, host, port
   A supplied server or executable-server port must be an integer from 1 through
   65535.
   Do not guess an adapter command. Confirm it from the project or ask for it.
5. Only use these general variables: ${workspaceFolder},
   ${workspaceFolderBasename}, ${workspaceFolder:<current-folder-name>},
   ${file}, ${fileBasename}, ${fileDirname}, ${relativeFile}, ${pathSeparator},
   and ${env:NAME}. ${host} and ${port} may additionally be used only in the
   args of an executable-server adapter.
6. Never use ${command:...} or ${input:...}. Do not rely on inputs, compounds,
   preLaunchTask, postDebugTask, platform-specific windows/linux/osx merging,
   presentation, or serverReadyAction; Logos does not implement those VS Code
   editor features.
7. Treat program, args, cwd, env, envFile, console, url, webRoot,
   runtimeExecutable, runtimeArgs, skipFiles, outFiles, and similar fields as
   adapter-specific. Include them only when they are valid for the selected
   adapter and request. Never set console to externalTerminal; Logos supports
   internalConsole and integratedTerminal instead.
8. If ${file} or another active-file variable is used, remind the user to open
   a regular file before starting the debugger.

Output the target path, then one complete JSONC code block. After the code,
state assumptions or prerequisites in at most three bullets. Explicitly say
whether the generated syntax is close to VS Code's launch.json and why. If the
configuration can be shared in .vscode/launch.json, say so. If it uses the
Logos-specific adapter field or another unsupported VS Code feature, say that
it is Logos-specific instead.
```

Review generated commands and paths before starting the debugger. For a custom
runtime, also verify the selected adapter's own launch/attach schema.
