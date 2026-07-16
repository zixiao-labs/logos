# Agent Runtimes

Logos supports three runtime families from the Agent panel:

- **Logos**: the built-in OpenAI Responses runtime with workspace tools, permissions,
  resumable local sessions, cancellation, and protocol tracing.
- **Claude**: the existing Claude Agent SDK integration.
- **ACP**: manually configured agents and agents discovered through the canonical
  [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).

## Logos Authentication

Open **Settings > Model APIs & ChatGPT** and choose one method:

- **Connect ChatGPT** opens the ChatGPT Plus/Pro PKCE login flow in the browser.
- **Use API key** stores an OpenAI API key for direct Responses API access.

OAuth tokens and API keys are encrypted with Electron `safeStorage` and written to
the operating system's per-user Logos data directory. They are not stored in
`settings.json` or renderer local storage. Logging out removes the encrypted file.

`agent.openaiBaseUrl` applies only to API-key requests. ChatGPT subscription requests
use the Codex Responses endpoint selected by the OAuth transport.

## OpenAI Models

The built-in runtime defaults to `gpt-5.6-sol` and also exposes the GPT-5.6 Terra
and Luna tiers. Each tier supports `none`, `low`, `medium`, `high`, `xhigh`, and
`max` reasoning effort. With Auto selected, GPT-5.6 uses medium effort.

Each GPT-5.6 tier has a Fast mode that requests priority processing. Pro mode uses
OpenAI's Pro reasoning mode and is available with API-key authentication; the ChatGPT
Codex endpoint does not support Pro mode or the bare `gpt-5.6` alias. Logos therefore
uses the explicit `gpt-5.6-sol` model ID as its cross-authentication default.

## Workspace Tools

The Logos runtime provides `read_file`, `list_directory`, `search`, `write_file`, and
`run_command`. The exact tool contract and the mode-specific system prompt are shown
at the top of every Logos thread before its first prompt.
Paths are constrained to the active workspace, including real-path checks that reject
symbolic-link escapes. Write and command tools follow the selected permission mode.
Threads are bound to the workspace where they started and cannot silently continue in
another folder.

## ACP Registry

Logos refreshes the canonical registry with ETag revalidation and a five-minute cache.
The last valid snapshot remains available when offline.

Binary distributions are downloaded lazily into the Logos user-data directory. Logos
verifies SHA-256 when supplied, rejects unsafe archive paths and links, and supports
raw binaries, ZIP, tar.gz, tgz, tar.bz2, and tbz2.

`npx` and `uvx` distributions are shown as available only when the corresponding
package runner can be found on the host. Package specifications and arguments are
passed as separate argv values; no shell command is constructed.

Registry ACP processes receive a restricted inherited environment so credentials from
the Logos process are not automatically exposed to third-party agents. ACP agents are
still native local processes and should only be run when their publisher is trusted.

## Agent Debug

Each active thread exposes a collapsed **Agent Debug** timeline. It includes Logos
request lifecycle, model output items, tool calls/results, errors, and ACP lifecycle,
session updates, and stderr. Trace payloads are capped in the renderer and are not
persisted with conversation history.
