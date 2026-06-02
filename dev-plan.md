# Logos Workstation Edition Development Plan

Stage 1: Basic Functions

Editor (Monaco Editor), File Browser, Git, Settings (GUI and JSON), Chinese/English Interface，Terminal (xterm.js), Markdown Preview, WebView, Extension Manager (with Marketplace support), Built-in Claude agent, Vim/Helix Keymap,VS Code/Cursor Layout, and more.

Stage 2: Intelligent Completion and Advanced Features

Sprint1：Access to common language servers + automatic download/update

Advanced features such as rainbow brackets and semantic search will be provided through wasm integration with Tree-sitter.

Stage 3: Extension Host

Using its own Logos JS extension and Wasm extension host, it is incompatible with VS Code, which is clean and can extend security features such as a virtual file system.

Stage 3.5: Debugging

Debug Adapter Protocol (DAP)

Built-in Node.js/Chrome/Electron adapters

Extended language support via Extension Host

Stage 4: Connectivity and Collaboration

Github/GitLab Login

~~Zixiaolabs Cloud Account Login~~ (blocked by cloud infrastructure not yet deployed)

Issue/MR Management

Pipeline Management

Deployment Management

CRDT Real-time Collaboration (P2P temporarily enabled and not yet deployed Wuling workspace (Provided by [Wuling DevOps](https://github.com/zixiao-labs/Wuling-DevOps)，requires container development functionality to be ready))

SSH and Container Development

Connect to WSL (Linux Subsystem on Windows)

---

# Path to "Basically Usable" — Stage 2 Sprint 1 Hardening

> Audit date: 2026-06-02. Method: 6-agent code audit (LSP, Agent panel, Monaco
> suggest UI, status bar, shared contract) + adversarial completeness critic.
> Every gap below is backed by `file:line` evidence. Effort: **S** ≤ 1h,
> **M** ≤ ½ day, **L** ≥ 1 day.

> **Implementation status — 2026-06-02 (branch `feat/stage2-p0-hardening`).**
> All workstreams below (P0 + P1 + P2 + G1) are implemented. `npx tsc --noEmit`,
> `nasti build`, and `nasti electron-build` all pass clean. Per-workstream notes:
>
> - **A1** ✅ `lsp-monaco.ts`: root check moved above attempt-recording; boolean
>   lock replaced by an in-flight `Map` cleared in `finally`; `onProgress`
>   drops crashed servers **and** their `openDocs`; `lspChangeDoc` re-ensures a
>   downed server; workspace null→set re-opens pre-folder docs.
> - **A2** ✅ `lsp.ts`: `install()` now *rejects* on non-zero exit / spawn error;
>   `start()` verifies the bin via `fs.access` before spawn.
> - **B1** ✅ `agent.ts` `authEnv()` merges `{...process.env, ANTHROPIC_*}` only
>   when a credential is set (else inherits, preserving the dev flow); masked
>   key/token + baseURL rows in `SettingsView`; first-run auth-error action.
> - **B2** ✅ settings keys + `AgentStartRequest` fields + `defaults.ts` + store
>   translation + conditional-spread into `Options` (incl. `resume`).
> - **C1** ✅ store `lsp` slice + `bootstrap()` hydrate/subscribe; status-bar
>   indicator; `ExtensionsView` reads the slice (single source of truth).
> - **C2** ✅ `logos:lsp-ready` re-triggers suggest on `running`; completion
>   forwards `context` + returns `incomplete`.
> - **D1–D4** ✅ in-panel model / effort (gated by model) / thinking / permission
>   controls; always-allow on `PermissionCard`; leading-`/` slash-command menu;
>   `CH.agentListModels`/`agentListCommands` via a cached SDK probe (15s timeout,
>   static model fallback pre-auth); `settingSources:['user','project']`.
> - **E1** ✅ scoped `.monaco-editor` `content-box` + `line-height:normal` guard
>   after the `*` reset. ⚠️ Mechanism was reasoned-from-CSS; the guard ships and
>   builds, but a **live devtools confirmation of the single-row clip was not
>   run in this (headless) pass** — confirm visually when next running the app.
> - **F1** ✅ `didSave`; `textEdit`/`additionalTextEdits`/snippet
>   `insertTextFormat`; `completionItem/resolve`; dedicated `css` server split.
> - **F2** ✅ `sdkSessionId` captured + `resume` plumbed; agent conversations
>   persisted to `localStorage` (debounced, sanitized on rehydrate). *Chosen over
>   the `persist` middleware to avoid a 450-line re-indent of the store; same
>   behaviour.*
> - **F3** ✅ auth-error → "Set API key" action; status-bar run spinner that
>   reveals the agent's secondary panel.
> - **F4** ✅ `GitPanel` stage-all-then-commit; Commit disabled w/ tooltip when
>   nothing to commit.
> - **G1** ✅ *code-side*: PATH augmented (`/usr/local/bin`, `/opt/homebrew/bin`,
>   …, `resourcesPath/bin`) on every npm/server spawn; servers resolved from
>   `resourcesPath/language-servers` first (bundle hook) then the managed dir;
>   clear "Node.js / npm not found" error. ⚠️ **Remaining release step:** actually
>   ship the 5 server packages under `resources/language-servers/node_modules`
>   via electron-builder `extraResources` — that's a packaging change, not code.


## What already works (do NOT rebuild)

The LSP and Agent stacks are **more complete than they appear** — the perceived
"nothing is done" is mostly missing *surfacing* and a few silent-failure bugs:

- **LSP is wired end-to-end.** `setupLspMonaco()` is called (`App.tsx:19`) and
  registers completion/hover/definition providers + a diagnostics listener
  (`lsp-monaco.ts:156-288`). `MonacoEditor.tsx` drives didOpen/didChange/didClose
  (`:122/:120/:160`). The backend (`electron/services/lsp.ts`) has a 5-server
  registry (TS, Pyright, JSON, HTML/CSS, Bash), installs via npm, and runs them
  over `vscode-jsonrpc`. A working management UI exists (`ExtensionsView.tsx`,
  reachable from the Activity Bar). `lsp.autoDownload` defaults **true**
  (`defaults.ts:20`). The Problems panel renders diagnostics (`Panel.tsx:106-160`).
- **The Agent chat loop works** end-to-end: streaming text/thinking/tool-use,
  per-request permission cards, AskUserQuestion cards, interrupt. `model` and
  `permissionMode` are already threaded from settings.
- **The preload/IPC bridge is complete** — `lsp.onProgress`, `lsp.onNotify`,
  `settings.setMany`, all agent methods exist. The settings service open-merges
  (`{...current, ...patch}`), so **new settings keys need no backend/channel
  changes** — only types, defaults, store mapping, and UI.

## Definition of "basically usable"

1. Open a TS/JS/Python/JSON/HTML/CSS/Bash file → completions, hover, and
   diagnostics actually appear, with **visible status** while servers download/start.
2. The Agent panel is genuinely usable: it **authenticates**, and exposes
   **model selection, permission settings, slash-commands, and reasoning effort**.
3. The editor autocomplete widget renders correctly (no clipped single-row).

## Workstream summary

| ID | Workstream | Priority | Effort | Addresses |
|----|-----------|----------|--------|-----------|
| A1 | LSP: stop `startAttempts` poisoning + self-heal | **P0** | S | "LSP process never starts" |
| A2 | LSP: `install()` must fail loudly; verify bin before start | **P0** | M | silent download failure |
| B1 | Agent: authentication path (env merge + key/token/baseURL + UI) | **P0** | M–L | agent only emits errors |
| B2 | Agent: contract plumbing (settings + request + store + consumer) | **P0** | S×4 | foundation for all agent controls |
| C1 | LSP status surfacing: store slice + bootstrap sub + **status-bar indicator** | **P1** | M | "status bar not enhanced" |
| C2 | LSP: re-trigger suggest on ready; forward `context` + `isIncomplete` | **P1** | M | empty/stale completions |
| D1 | Agent UI: model picker | **P1** | M | model selection |
| D2 | Agent UI: effort / thinking control | **P1** | M | effort / thinking depth |
| D3 | Agent UI: in-panel permission mode + allowlist + "always allow" | **P1** | M | permission settings |
| D4 | Agent UI: slash-command discovery + menu | **P1** | M | slash-commands |
| E1 | Monaco suggest widget: scoped `.monaco-editor` CSS reset | **P1** | S | single-row clip (screenshot) |
| F1 | LSP robustness: didSave, textEdit/snippet, resolve, css/html split | P2 | M | completion correctness |
| F2 | Agent: resume + session persistence | P2 | L | conversation survives restart |
| F3 | Agent: actionable auth-error + status-bar run indicator | P2 | S | error legibility |
| F4 | Git: commit-with-nothing-staged no-op | P2 | S | usability dead-end |
| G1 | **Release blocker:** bundle language servers / fix npm-on-PATH | P0-ship | L | packaged app can't download |

---

## P0 — Make the two features actually function

### A1. LSP: stop `startAttempts` poisoning + self-heal (S) — *highest-leverage LSP fix*
`ensureServer()` (`lsp-monaco.ts:37-60`) adds the server id to `startAttempts`
**before** the null-root check (`:42` then `:44-45`) and **never clears it on
failure** (no `startAttempts.delete` exists anywhere). The common first-run flow —
app opens on Welcome (`root === null`), user opens a loose file — permanently
disables that language for the whole window session, even after a folder is opened.
- Move the `root` check **above** `startAttempts.add`.
- Replace the boolean lock with a `Map<serverId, Promise>` of in-flight starts, or
  wrap the body in `try/finally` and delete from `startAttempts` on every failure path.
- In `setupLspMonaco`, also subscribe to `lsp.onProgress`: on `stopped`/`error`,
  drop the id from `startedServers` **and** `startAttempts` so a crashed server
  self-heals on the next keystroke (fixes the crash→desync gap, `lsp.ts:244-247`).
- Re-run `ensureServer` on `workspace.onChanged` (null→set root).
- **Accept:** open a loose `.ts` file before opening a folder, then open a folder →
  completions still arrive; kill the server process → it restarts on next edit.

### A2. LSP: `install()` must fail loudly; verify bin before start (M)
`install()` calls `resolve()` on **both** success and non-zero exit
(`lsp.ts:201-209`), so `ensureServer` proceeds to `start()` against a missing
`.bin`, and the spawn error is swallowed.
- Make `install()` reject / return `{ok:false,error}` on non-zero exit or spawn error.
- `fs.access(binPath)` before spawn in `start()` (`lsp.ts:232`); throw a clear
  "server not installed" error.
- Propagate failures into the LSP store slice (C1) so they reach the status bar.
- **Accept:** with npm unavailable, the status bar shows a red, actionable LSP error
  instead of silent emptiness.

### B1. Agent: authentication path (M–L) — *agent is non-functional without it*
`agent.ts` builds SDK `Options` with **no `apiKey`** and intentionally omits `env`
(`:209-212`), relying on the main process having inherited `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_BASE_URL` or `~/.claude`. This works **only** when launched from a
configured terminal (your current `nasti electron` dev flow). A packaged app
launched from Finder/Dock/Explorer inherits **no login shell env**, and there is no
in-app way to supply credentials (grep: only the `agent.ts:210` comment mentions
ANTHROPIC) → the panel emits a single cryptic error and nothing else.
- Add settings: `agent.apiKey` (or `agent.authToken`) + `agent.baseUrl`
  (`types.ts`/`defaults.ts`), with a **masked** SettingsView row + a first-run prompt
  in the Agent panel when no credential is detected.
- In `agent.ts startSession`, set `Options.env` to a **merge** — `{ ...process.env,
  ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL: ... }` (must spread
  `process.env`, not replace it; see the existing comment) — or integrate the SDK
  setup-token/login flow.
- **Accept:** a fresh user with no shell env can paste a key in Settings and get a
  streamed reply.
- *Note:* not blocking for the developer's current terminal-launched dev build, but
  it is a hard blocker for "usable by anyone else" and for shipping.

### B2. Agent: contract plumbing for new controls (S each — do together)
Foundation for D1–D4. No channel/preload changes needed (open-merge settings +
existing `agentStart` payload).
1. **`types.ts`** — add settings keys + `AgentStartRequest` fields:
   `agent.effort` (`'low'|'medium'|'high'|'xhigh'|'max'|''`), `agent.thinking`
   (`'adaptive'|'enabled'|'disabled'`), `agent.thinkingBudget: number`,
   `agent.allowedTools: string[]`, `agent.disallowedTools: string[]`,
   `agent.loadProjectSettings: boolean`. Mirror onto `AgentStartRequest` as
   optionals; use the SDK's exact `thinking` discriminated-union shape so it maps 1:1.
2. **`defaults.ts`** — defaults: effort `''` (defer to model), thinking `'adaptive'`,
   thinkingBudget `8000`, allow/disallow `[]`, loadProjectSettings `true`.
3. **`store.ts sendAgentPrompt`** (`:472-478`) — translate settings → request fields
   (`|| undefined` where empty means "no override", mirroring `model` at `:476`).
4. **`agent.ts startSession`** (`:204`) — conditional-spread `effort`, `thinking`,
   `allowedTools`, `disallowedTools`, `settingSources`, `systemPrompt` (and finally
   honor `resume`) into `Options`.

---

## P1 — Visibility + the explicitly-requested controls

### C1. LSP status surfacing + status-bar indicator (M) — *the "status bar not enhanced" ask*
There is **no `lsp` slice** in the store and **no LSP item** in `StatusBar.tsx`;
the only `onProgress` subscriber is `ExtensionsView` (usually closed), so
auto-install/start happens invisibly.
- Add `lsp: Record<string, LspProgress>` + `setLspProgress()` to the store;
  hydrate from `lsp.list()` and subscribe to `lsp.onProgress` once in `bootstrap()`.
- In `StatusBar.tsx`, for `active.kind === "file"`, resolve
  `serverIdForLanguage(active.language)` (already exported, `language.ts:86`) and
  render a status item next to the language id: `Install <lang>` / `Installing…` /
  `Starting…` / `<lang> ✓` / red `LSP error`. Click → `openSpecial("extensions")`.
- Refactor `ExtensionsView` to read the same store slice (single source of truth).
- Add i18n keys (`lsp.starting`, `lsp.installing`, `lsp.error`) for en + zh.
- **Accept:** opening a `.py` file with Pyright absent shows "Installing Python
  server…" then "Python ✓" in the status bar.

### C2. LSP: re-trigger suggest on ready + forward completion context (M)
On first open the provider returns `{suggestions:[]}` while the server starts
(`lsp-monaco.ts:165`) and Monaco never re-queries; separately the provider sends no
`context` and drops `CompletionList.isIncomplete` (`:166-196`), so tsserver
"incomplete" lists go stale while typing.
- When a server reaches `running` for an open model, fire
  `editor.trigger('lsp','editor.action.triggerSuggest',{})` (via a window event
  from `ensureServer`).
- Pass `context: { triggerKind, triggerCharacter }` and return
  `{ suggestions, incomplete: list.isIncomplete }`.
- **Accept:** typing `foo.` immediately after opening a file (cold server) shows
  members once ready, without deleting/retyping.

### D1–D4. Agent panel controls (M each — all depend on B1 auth + B2 plumbing)
The input-row `Local + chevron` (`AgentPanel.tsx:197-200`) is **decorative** (no
handler). Build real controls there:
- **D1 Model picker:** add `CH.agentListModels` → `query.supportedModels()`
  (`ModelInfo[]`, includes `supportsEffort`/`supportedEffortLevels`); cache in store;
  bind a dropdown to `agent.model` (keep a "Default" option).
- **D2 Effort / thinking:** dropdown bound to `agent.effort`, gated by the selected
  model's `supportedEffortLevels` (Opus 4.8 supports up to `max`); optional thinking
  mode select.
- **D3 Permissions:** in-panel `permissionMode` selector (bound to
  `agent.permissionMode`, no Settings trip); add an **"Always allow {tool}"** button
  to `PermissionCard` that appends to `agent.allowedTools`; expose allow/disallow
  lists in SettingsView.
- **D4 Slash-commands:** set `settingSources: ['user','project']` so `.claude/commands`
  load; add `CH.agentListCommands` → `query.supportedCommands()` (`SlashCommand[]`);
  in the textarea `onChange`, detect a leading `/\w*$` and show a menu (mirror the
  existing `@`-mention menu at `:165-184`); suppress Enter-submit while it's open.
- Also expose D1–D3 rows in `SettingsView` (after `:215`) + i18n keys.

### E1. Monaco suggest widget single-row clip (S) — *the screenshot bug*
**Confirmed real** (screenshot: single-row "type" suggestion is vertically clipped
and overlaps the line below). Root cause is host CSS leaking into Monaco's
internally-rendered DOM — there are **zero** project Monaco overrides, so the global
`* { box-sizing: border-box }` (`app.css:6`) **and** the `body` `line-height: normal`
(no line-height reset on `.monaco-editor`) both cascade into the suggest widget,
whose single-row height is hard-clamped to `itemHeight` (≈20px at fontSize 13).
- Add, **after** the `*` reset, a scoped guard in `app.css`:
  `.monaco-editor, .monaco-editor *, .monaco-editor *::before, .monaco-editor *::after { box-sizing: content-box; line-height: normal; }`
  (comment it as a "Monaco embed guard"; also protects hover/param-hints/find widgets).
- **Verify before closing:** the critic flagged the *mechanism* as reasoned-from-CSS,
  not from a live repro — reproduce a single-item completion, inspect the rendered
  `.monaco-list-row` in devtools, confirm the clip is gone. (Both resets are safe and
  S-effort; ship together, then confirm visually.)

---

## P2 — Robustness & polish (after the above)

- **F1 LSP correctness:** send `textDocument/didSave` from `saveCurrent`
  (`MonacoEditor.tsx:143`); honor server `textEdit`/`additionalTextEdits` +
  snippet `insertTextFormat` (`lsp-monaco.ts:176-194`); `completionItem/resolve` for
  docs; split a dedicated `css` server (`vscode-css-language-server`) from `html`
  (`lsp.ts:49-57`, `language.ts:96-99`).
- **F2 Agent resume/persistence (L):** capture `sdkSessionId` (`agent.ts:188`,
  discarded at `store.ts:584-591`) onto the session; persist `agentSessions` (zustand
  `persist`); pass `resume` so conversations survive restart.
- **F3 Agent error legibility:** detect 401/"not authenticated" and render an
  actionable "Set API key in Settings" action; add a status-bar agent run indicator
  (spinner when any session is `running`, click → reveal panel) and retire/with the
  dead "Local" footer.
- **F4 Git:** disable Commit (or stage-all-then-commit) when nothing is staged —
  today it silently no-ops (`GitPanel.tsx:138-151`, `git.ts:78-82`).

## G1 — Release blocker (before any packaged build)

`install()`/`latestVersion()` shell out to bare `npm` (`lsp.ts:94/115/182`) with no
PATH augmentation. A packaged Electron app launched from the GUI has no login-shell
PATH, so `npm` is usually absent → downloads fail. **Dev builds are unaffected** (npm
is on PATH), so this can trail P0/P1 for local work, but it gates shipping.
- Preferred: **bundle** the 5 server packages as a release artifact (ship their
  `node_modules` under `resources/`, or download prebuilt tarballs from GitHub
  releases), and run them via the bundled node/Electron binary.
- Interim: preflight `which npm`, augment `env.PATH`
  (`/usr/local/bin`, `/opt/homebrew/bin`, `process.resourcesPath`), surface a clear
  "Node.js not found" error.

## Suggested sequence

1. **A1 + B1 + B2** in parallel → LSP completions reliably appear and the Agent
   authenticates. (This alone clears most of the "nothing works" perception.)
2. **A2 + C1** → failures are visible; status bar shows server state.
3. **E1** (quick win, verify in devtools) + **C2**.
4. **D1–D4** → the four requested Agent controls (depend on B1/B2).
5. **F-series** polish; **G1** before the first packaged release.
