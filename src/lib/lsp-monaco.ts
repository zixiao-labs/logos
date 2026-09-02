import * as monaco from "monaco-editor";
import type {
  CodeAction as LspCodeAction,
  CodeLens as LspCodeLens,
  ColorInformation,
  ColorPresentation,
  Command as LspCommand,
  Diagnostic as LspDiagnostic,
  DocumentLink,
  DocumentSymbol as LspDocumentSymbol,
  FoldingRange as LspFoldingRange,
  InlayHint as LspInlayHint,
  LinkedEditingRanges,
  Location as LspLocation,
  LocationLink as LspLocationLink,
  Range as LspRange,
  SelectionRange as LspSelectionRange,
  SemanticTokens,
  SemanticTokensDelta,
  ServerCapabilities,
  SignatureHelp,
  SymbolInformation,
  TextEdit as LspTextEdit,
  WorkspaceEdit as LspWorkspaceEdit,
} from "vscode-languageserver-protocol";
import { useStore, type Diagnostic } from "../state/store";
import { serverIdForLanguage } from "./language";
import {
  matchesLspDocumentSelector,
  matchesLspGlob,
  resolveLspConfiguration,
  type LspRegistration,
} from "./lsp-client";
import { applyLspTextEdits, isSafeWordPattern } from "./lsp-utils";
import { notify, notifyError, notifyInfo } from "./toast";
import { createMultiBufferDocument } from "./multibuffer";

/**
 * Bridges the in-renderer Monaco editor to the language servers managed by the
 * main process. Providers forward to `window.logos.lsp.request`; diagnostics
 * arrive via `window.logos.lsp.onNotify`.
 */

const MONACO_LANGS = [
  "typescript",
  "javascript",
  "json",
  "html",
  "css",
  "scss",
  "less",
  "python",
  "go",
  "rust",
  "shell",
];

/** Monaco language id -> LSP languageId. */
function lspLanguageId(monacoLang: string, path = ""): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "tsx") return "typescriptreact";
  if (extension === "jsx") return "javascriptreact";
  if (extension === "jsonc" || extension === "json5") return "jsonc";
  if (monacoLang === "shell") return "shellscript";
  return monacoLang;
}

const startedServers = new Set<string>();
const serverCapabilities = new Map<string, ServerCapabilities>();
/** Server id -> in-flight start promise (dedupes concurrent ensures). */
const inflight = new Map<string, Promise<string | null>>();
/** Open path -> owning server id. */
const openDocs = new Map<string, string>();
const sentDidOpen = new Set<string>();
const openingDocs = new Set<string>();
const publishedDiagnostics = new Map<string, LspDiagnostic[]>();
const diagnosticOwners = new Map<string, string>();
const dynamicRegistrations = new Map<string, Map<string, LspRegistration>>();
const disabledStaticCapabilities = new Map<
  string,
  Set<keyof ServerCapabilities>
>();
const diagnosticResultIds = new Map<string, string>();
const diagnosticRequestGenerations = new Map<string, number>();
const diagnosticControllers = new Map<string, AbortController>();
const workspaceDiagnosticGenerations = new Map<string, number>();
const workspaceDiagnosticTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const workspaceDiagnosticControllers = new Map<string, AbortController>();
const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
const workDoneTokens = new Map<string, Set<string | number>>();
const partialResultHandlers = new Map<
  string,
  (value: unknown) => void
>();
const semanticTokenListeners = new Map<
  string,
  Set<(event: void) => unknown>
>();
const codeLensListeners = new Set<() => unknown>();
const inlayHintListeners = new Set<(event: void) => unknown>();
const inlineCompletionListeners = new Set<(event: void) => unknown>();
let nextRequestId = 1;
let rootChangeGeneration = 0;

const CAPABILITY_METHOD: Partial<Record<keyof ServerCapabilities, string>> = {
  completionProvider: "textDocument/completion",
  hoverProvider: "textDocument/hover",
  signatureHelpProvider: "textDocument/signatureHelp",
  declarationProvider: "textDocument/declaration",
  definitionProvider: "textDocument/definition",
  typeDefinitionProvider: "textDocument/typeDefinition",
  implementationProvider: "textDocument/implementation",
  referencesProvider: "textDocument/references",
  documentHighlightProvider: "textDocument/documentHighlight",
  documentSymbolProvider: "textDocument/documentSymbol",
  codeActionProvider: "textDocument/codeAction",
  codeLensProvider: "textDocument/codeLens",
  documentLinkProvider: "textDocument/documentLink",
  documentFormattingProvider: "textDocument/formatting",
  documentRangeFormattingProvider: "textDocument/rangeFormatting",
  documentOnTypeFormattingProvider: "textDocument/onTypeFormatting",
  renameProvider: "textDocument/rename",
  foldingRangeProvider: "textDocument/foldingRange",
  selectionRangeProvider: "textDocument/selectionRange",
  linkedEditingRangeProvider: "textDocument/linkedEditingRange",
  colorProvider: "textDocument/documentColor",
  inlayHintProvider: "textDocument/inlayHint",
  semanticTokensProvider: "textDocument/semanticTokens",
  callHierarchyProvider: "textDocument/prepareCallHierarchy",
  typeHierarchyProvider: "textDocument/prepareTypeHierarchy",
  monikerProvider: "textDocument/moniker",
  inlineCompletionProvider: "textDocument/inlineCompletion",
  diagnosticProvider: "textDocument/diagnostic",
  workspaceSymbolProvider: "workspace/symbol",
  executeCommandProvider: "workspace/executeCommand",
};

function requestLsp<T>(
  serverId: string,
  method: string,
  params: unknown,
  token?: monaco.CancellationToken,
  timeoutMs?: number,
): Promise<T> {
  if (token?.isCancellationRequested) return Promise.reject(new Error("Canceled"));
  const requestId = nextRequestId++;
  const cancellation = token?.onCancellationRequested(() =>
    window.logos.lsp.cancelRequest(serverId, requestId),
  );
  const request = window.logos.lsp.request(serverId, method, params, requestId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = timeoutMs
    ? Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            window.logos.lsp.cancelRequest(serverId, requestId);
            reject(new Error(`LSP request timed out: ${method}`));
          }, timeoutMs);
        }),
      ])
    : request;
  return result.finally(() => {
    if (timeout) clearTimeout(timeout);
    cancellation?.dispose();
  }) as Promise<T>;
}

function cancellationTokenForSignal(
  signal: AbortSignal | undefined,
): monaco.CancellationToken | undefined {
  if (!signal) return undefined;
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(listener) {
      signal.addEventListener("abort", listener, { once: true });
      return { dispose: () => signal.removeEventListener("abort", listener) };
    },
  };
}

async function requestLspWithPartialResults<T>(
  serverId: string,
  method: string,
  params: Record<string, unknown>,
  token?: monaco.CancellationToken,
  onPartial?: (items: T[]) => void,
): Promise<T[]> {
  const partialResultToken = `logos:partial:${serverId}:${nextRequestId}`;
  const key = `${serverId}:${partialResultToken}`;
  const partial: T[] = [];
  partialResultHandlers.set(key, (value) => {
    if (Array.isArray(value)) {
      const items = value as T[];
      partial.push(...items);
      onPartial?.(items);
    }
  });
  try {
    const result = await requestLsp<T[] | null>(
      serverId,
      method,
      { ...params, partialResultToken },
      token,
    ).catch(() => null);
    return [...partial, ...(result ?? [])];
  } finally {
    partialResultHandlers.delete(key);
  }
}

function fireSemanticTokensChanged(serverId: string) {
  for (const language of MONACO_LANGS) {
    if (serverIdForLanguage(language) !== serverId) continue;
    for (const listener of semanticTokenListeners.get(language) ?? []) {
      listener();
    }
  }
}

function fireProviderRefresh(serverId: string) {
  fireSemanticTokensChanged(serverId);
  for (const listener of codeLensListeners) listener();
  for (const listener of inlayHintListeners) listener();
  for (const listener of inlineCompletionListeners) listener();
}

function uriOf(path: string): string {
  return monaco.Uri.file(path).toString();
}

function syncOptions(serverId: string) {
  return serverCapabilities.get(serverId)?.textDocumentSync;
}

function syncRegistration(
  serverId: string,
  method: string,
  model?: monaco.editor.ITextModel | null,
) {
  return [...(dynamicRegistrations.get(serverId)?.values() ?? [])].find(
    (registration) =>
      registration.method === method &&
      (!model ||
        matchesLspDocumentSelector(
          registration.registerOptions,
          lspLanguageId(model.getLanguageId(), model.uri.fsPath),
          { scheme: model.uri.scheme, path: model.uri.path },
        )),
  );
}

function diagnosticKey(serverId: string, uri: string) {
  return `${serverId}\u0000${uri}`;
}

function dynamicCapability<K extends keyof ServerCapabilities>(
  serverId: string,
  model: monaco.editor.ITextModel,
  key: K,
): NonNullable<ServerCapabilities[K]> | undefined {
  const method = CAPABILITY_METHOD[key];
  if (!method) return undefined;
  for (const registration of dynamicRegistrations.get(serverId)?.values() ?? []) {
    if (registration.method !== method) continue;
    if (
      !matchesLspDocumentSelector(
        registration.registerOptions,
        lspLanguageId(model.getLanguageId(), model.uri.fsPath),
        { scheme: model.uri.scheme, path: model.uri.path },
      )
    ) {
      continue;
    }
    return (registration.registerOptions ?? true) as NonNullable<
      ServerCapabilities[K]
    >;
  }
  return undefined;
}

function serverCapability<K extends keyof ServerCapabilities>(
  serverId: string,
  key: K,
): NonNullable<ServerCapabilities[K]> | undefined {
  const method = CAPABILITY_METHOD[key];
  if (method) {
    const registration = [
      ...(dynamicRegistrations.get(serverId)?.values() ?? []),
    ].find((item) => item.method === method);
    if (registration) {
      return (registration.registerOptions ?? true) as NonNullable<
        ServerCapabilities[K]
      >;
    }
  }
  if (disabledStaticCapabilities.get(serverId)?.has(key)) return undefined;
  return serverCapabilities.get(serverId)?.[key] as
    | NonNullable<ServerCapabilities[K]>
    | undefined;
}

async function ensureServer(monacoLang: string): Promise<string | null> {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId) return null;
  if (startedServers.has(serverId) && serverCapabilities.has(serverId))
    return serverId;

  // A1: check the workspace root BEFORE recording any attempt. The first-run
  // flow (app opens on Welcome, root === null, user opens a loose file) must
  // not permanently disable this language — once a folder is opened, the next
  // edit re-attempts. A null root is a no-op, not a poisoned state.
  const root = useStore.getState().root;
  if (!root) return null;

  // Dedupe concurrent starts. The promise is removed in `finally`, so a failed
  // start (rejected install/spawn) self-heals: the next keystroke re-attempts.
  const existing = inflight.get(serverId);
  if (existing) return existing;

  const attempt = (async (): Promise<string | null> => {
    const servers = await window.logos.lsp.list();
    const info = servers.find((s) => s.id === serverId);
    if (!info) return null;
    if (info.status === "not-installed") {
      if (!useStore.getState().settings["lsp.autoDownload"]) return null;
      // A2: install() now rejects on failure, so we never fall through to
      // start() against a missing binary.
      await window.logos.lsp.install(serverId);
    }
    return activateLspServer(serverId, root);
  })();
  inflight.set(serverId, attempt);
  try {
    return await attempt;
  } catch {
    return null;
  } finally {
    inflight.delete(serverId);
  }
}

export async function activateLspServer(
  serverId: string,
  root: string,
): Promise<string | null> {
  const capabilities = await window.logos.lsp.start(serverId, root);
  if (useStore.getState().root !== root) {
    await window.logos.lsp.stop(serverId);
    return null;
  }
  serverCapabilities.set(serverId, capabilities);
  disabledStaticCapabilities.delete(serverId);
  startedServers.add(serverId);
  fireProviderRefresh(serverId);
  reopenModelsFor(serverId);
  window.dispatchEvent(
    new CustomEvent("logos:lsp-ready", { detail: { serverId } }),
  );
  void pullWorkspaceDiagnostics(serverId);
  return serverId;
}

export function lspOpenDoc(path: string, monacoLang: string, content: string) {
  void (async () => {
    const serverId = await ensureServer(monacoLang);
    if (!serverId) return;
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    if (openDocs.has(path)) return; // already opened (e.g. by reopenModelsFor)
    openDocs.set(path, serverId);
    const sync = syncOptions(serverId);
    const sendsOpen =
      (typeof sync === "number" ? sync !== 0 : sync?.openClose === true) ||
      Boolean(syncRegistration(serverId, "textDocument/didOpen", model));
    if (sendsOpen) {
      const key = diagnosticKey(serverId, path);
      sentDidOpen.add(key);
      openingDocs.add(key);
      try {
        await window.logos.lsp.request(serverId, "textDocument/didOpen", {
          textDocument: {
            uri: uriOf(path),
            languageId: lspLanguageId(monacoLang, path),
            version: model.getVersionId(),
            text: model.getValue(),
          },
        });
      } catch {
        sentDidOpen.delete(key);
        return;
      } finally {
        openingDocs.delete(key);
      }
    }
    if (openDocs.get(path) !== serverId) return;
    scheduleDocumentDiagnostics(model, 0);
  })();
}

export function lspChangeDoc(
  path: string,
  monacoLang: string,
  content: string,
  version: number,
  changes?: Array<{ range: monaco.IRange; rangeLength: number; text: string }>,
) {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId) return;
  // A1 self-heal: if the server is down (never started, or crashed and was
  // dropped by the onProgress handler), (re)start it. reopenModelsFor on
  // 'running' re-sends didOpen with the current text, after which edits flow.
  if (!startedServers.has(serverId)) {
    void ensureServer(monacoLang).then((id) => {
      if (id) reopenModelsFor(id);
    });
    return;
  }
  if (openDocs.get(path) !== serverId) return;
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const sync = syncOptions(serverId);
  const dynamicChange = syncRegistration(
    serverId,
    "textDocument/didChange",
    model,
  )
    ?.registerOptions as { syncKind?: number } | undefined;
  const changeKind =
    dynamicChange?.syncKind ??
    (typeof sync === "number" ? sync : (sync?.change ?? 0));
  if (changeKind === 0) return;
  const contentChanges =
    changeKind === 2 && changes
      ? changes.map((change) => ({
          range: lspRange(change.range),
          rangeLength: change.rangeLength,
          text: change.text,
        }))
      : [{ text: content }];
  void window.logos.lsp.request(serverId, "textDocument/didChange", {
    textDocument: { uri: uriOf(path), version },
    contentChanges,
  });
  if (model) scheduleDocumentDiagnostics(model);
  const diagnosticOptions = serverCapability(serverId, "diagnosticProvider");
  if (
    typeof diagnosticOptions === "object" &&
    diagnosticOptions.interFileDependencies
  ) {
    for (const candidate of monaco.editor.getModels()) {
      if (
        candidate !== model &&
        serverIdForLanguage(candidate.getLanguageId()) === serverId
      ) {
        scheduleDocumentDiagnostics(candidate, 700);
      }
    }
  }
}

export function lspCloseDoc(path: string) {
  const serverId = openDocs.get(path);
  if (!serverId) return;
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  openDocs.delete(path);
  publishedDiagnostics.delete(uriOf(path));
  diagnosticOwners.delete(uriOf(path));
  diagnosticResultIds.delete(diagnosticKey(serverId, uriOf(path)));
  diagnosticRequestGenerations.delete(diagnosticKey(serverId, uriOf(path)));
  diagnosticControllers.get(diagnosticKey(serverId, uriOf(path)))?.abort();
  diagnosticControllers.delete(diagnosticKey(serverId, uriOf(path)));
  const diagnosticTimer = diagnosticTimers.get(uriOf(path));
  if (diagnosticTimer) clearTimeout(diagnosticTimer);
  diagnosticTimers.delete(uriOf(path));
  const sync = syncOptions(serverId);
  if (
    sentDidOpen.has(diagnosticKey(serverId, path)) &&
    ((typeof sync === "number" ? sync !== 0 : sync?.openClose === true) ||
      syncRegistration(serverId, "textDocument/didClose", model))
  ) {
    void window.logos.lsp.request(serverId, "textDocument/didClose", {
      textDocument: { uri: uriOf(path) },
    });
  }
  sentDidOpen.delete(diagnosticKey(serverId, path));
  openingDocs.delete(diagnosticKey(serverId, path));
  if (model) monaco.editor.setModelMarkers(model, "logos-lsp", []);
  useStore.getState().setDiagnostics(path, []);
}

export async function lspWillSaveDoc(
  path: string,
  monacoLang: string,
  reason = 1,
) {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId || !startedServers.has(serverId) || openDocs.get(path) !== serverId)
    return;
  const sync = syncOptions(serverId);
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const dynamicWillSave = syncRegistration(
    serverId,
    "textDocument/willSave",
    model,
  );
  const dynamicWait = syncRegistration(
    serverId,
    "textDocument/willSaveWaitUntil",
    model,
  );
  if (typeof sync !== "object" && !dynamicWillSave && !dynamicWait) return;
  const params = { textDocument: { uri: uriOf(path) }, reason };
  if ((typeof sync === "object" && sync.willSave) || dynamicWillSave) {
    await window.logos.lsp.request(serverId, "textDocument/willSave", params);
  }
  if ((typeof sync === "object" && sync.willSaveWaitUntil) || dynamicWait) {
    const edits = (await requestLsp<LspTextEdit[]>(
      serverId,
      "textDocument/willSaveWaitUntil",
      params,
      undefined,
      1_500,
    ).catch(() => null)) as LspTextEdit[] | null;
    if (edits?.length) {
      await applyTextDocumentEdit(uriOf(path), edits);
    }
  }
}

/** Notify the server that a document was saved (enables save-time linting). */
export function lspSaveDoc(path: string, monacoLang: string, content: string) {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId || !startedServers.has(serverId) || openDocs.get(path) !== serverId)
    return;
  const sync = syncOptions(serverId);
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const dynamicSave = syncRegistration(serverId, "textDocument/didSave", model)
    ?.registerOptions as { includeText?: boolean } | undefined;
  const save =
    dynamicSave ??
    (typeof sync === "number" ? sync !== 0 : (sync?.save ?? false));
  if (save) {
    void window.logos.lsp.request(serverId, "textDocument/didSave", {
      textDocument: { uri: uriOf(path) },
      text: typeof save === "object" && save.includeText ? content : undefined,
    });
  }
  if (model) scheduleDocumentDiagnostics(model, 0);
}

/**
 * Re-open every server-eligible model against a (re)started server. Used when
 * the workspace root changes (null -> set): documents opened before a folder
 * was chosen never reached `didOpen`, so we open them now.
 */
function reopenModelsFor(serverId: string) {
  for (const model of monaco.editor.getModels()) {
    const lang = model.getLanguageId();
    if (serverIdForLanguage(lang) !== serverId) continue;
    const path = model.uri.fsPath;
    if (openDocs.has(path)) continue;
    openDocs.set(path, serverId);
    const sync = syncOptions(serverId);
    const sendsOpen =
      (typeof sync === "number" ? sync !== 0 : sync?.openClose === true) ||
      Boolean(syncRegistration(serverId, "textDocument/didOpen", model));
    if (sendsOpen) {
      sentDidOpen.add(diagnosticKey(serverId, path));
      void window.logos.lsp
        .request(serverId, "textDocument/didOpen", {
          textDocument: {
            uri: model.uri.toString(),
            languageId: lspLanguageId(lang, path),
            version: model.getVersionId(),
            text: model.getValue(),
          },
        })
        .catch(() => sentDidOpen.delete(diagnosticKey(serverId, path)));
    }
    scheduleDocumentDiagnostics(model, 0);
  }
}

/** Kick off servers for all currently-open server-eligible models. */
function ensureServersForOpenModels() {
  const seen = new Set<string>();
  for (const model of monaco.editor.getModels()) {
    const lang = model.getLanguageId();
    const serverId = serverIdForLanguage(lang);
    if (!serverId || seen.has(serverId)) continue;
    seen.add(serverId);
    void ensureServer(lang).then((id) => {
      if (id) reopenModelsFor(id);
    });
  }
}

// --- LSP <-> Monaco enum conversions --------------------------------------

const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function lspPos(position: monaco.IPosition) {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function lspRange(range: monaco.IRange): LspRange {
  return {
    start: lspPos({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    }),
    end: lspPos({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    }),
  };
}

function markupValue(contents: unknown): string {
  if (contents == null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markupValue).join("\n\n");
  const c = contents as { value?: string; language?: string };
  if (c.value != null) {
    return c.language ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : c.value;
  }
  return "";
}

type LspCompletionTextEdit = LspTextEdit & {
  insert?: LspRange;
  replace?: LspRange;
};

/** Map LSP additionalTextEdits to Monaco's edit shape. */
function toMonacoEdits(
  edits: LspTextEdit[] | undefined,
): monaco.editor.ISingleEditOperation[] | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  return edits
    .map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
}

/** Monaco CompletionTriggerKind (0/1/2) -> LSP CompletionTriggerKind (1/2/3). */
function lspTriggerKind(kind: monaco.languages.CompletionTriggerKind): number {
  return kind + 1;
}

/**
 * Links a returned Monaco completion item back to its raw LSP item + server so
 * `completionItem/resolve` can lazily fetch documentation. WeakMap keeps it
 * tied to the item's lifetime without leaking.
 */
const resolveLinks = new WeakMap<
  monaco.languages.CompletionItem,
  { serverId: string; raw: Record<string, unknown>; resolveProvider: boolean }
>();

function capability<K extends keyof ServerCapabilities>(
  model: monaco.editor.ITextModel,
  key: K,
): { serverId: string; value: NonNullable<ServerCapabilities[K]> } | null {
  const serverId = serverIdForLanguage(model.getLanguageId());
  if (!serverId || !startedServers.has(serverId)) return null;
  const value =
    dynamicCapability(serverId, model, key) ??
    (disabledStaticCapabilities.get(serverId)?.has(key)
      ? undefined
      : serverCapabilities.get(serverId)?.[key]);
  if (!value) return null;
  if (
    typeof value === "object" &&
    "documentSelector" in value &&
    !matchesLspDocumentSelector(
      value as Record<string, unknown>,
      lspLanguageId(model.getLanguageId(), model.uri.fsPath),
      { scheme: model.uri.scheme, path: model.uri.path },
    )
  ) {
    return null;
  }
  return { serverId, value: value as NonNullable<ServerCapabilities[K]> };
}

async function requestForModel<T>(
  model: monaco.editor.ITextModel,
  capabilityKey: keyof ServerCapabilities,
  method: string,
  params: Record<string, unknown> = {},
  token?: monaco.CancellationToken,
): Promise<{ serverId: string; result: T } | null> {
  const supported = capability(model, capabilityKey);
  if (!supported) return null;
  const result = (await requestLsp<T>(
    supported.serverId,
    method,
    {
      textDocument: { uri: model.uri.toString() },
      ...params,
    },
    token,
  ).catch(() => null)) as T | null;
  return result == null ? null : { serverId: supported.serverId, result };
}

function toLocationLinks(result: unknown): monaco.languages.LocationLink[] | null {
  if (!result) return null;
  const values = Array.isArray(result) ? result : [result];
  const links = values.flatMap((value) => {
    const item = value as Partial<LspLocation & LspLocationLink>;
    if (item.targetUri && item.targetRange) {
      return [
        {
          uri: monaco.Uri.parse(item.targetUri),
          range: toMonacoRange(item.targetRange),
          targetSelectionRange: toMonacoRange(
            item.targetSelectionRange ?? item.targetRange,
          ),
          originSelectionRange: item.originSelectionRange
            ? toMonacoRange(item.originSelectionRange)
            : undefined,
        },
      ];
    }
    if (item.uri && item.range) {
      const range = toMonacoRange(item.range);
      return [
        {
          uri: monaco.Uri.parse(item.uri),
          range,
          targetSelectionRange: range,
        },
      ];
    }
    return [];
  });
  return links.length ? links : null;
}

function toLocations(result: LspLocation[] | null): monaco.languages.Location[] {
  return (result ?? []).map((location) => ({
    uri: monaco.Uri.parse(location.uri),
    range: toMonacoRange(location.range),
  }));
}

function toTextEdits(edits: LspTextEdit[] | null): monaco.languages.TextEdit[] {
  return (edits ?? []).map((edit) => ({
    range: toMonacoRange(edit.range),
    text: edit.newText,
  }));
}

function toCommand(
  serverId: string,
  command: LspCommand | undefined,
): monaco.languages.Command | undefined {
  if (!command) return undefined;
  return {
    id: "logos.lsp.executeCommand",
    title: command.title,
    arguments: [serverId, command],
  };
}

async function applyTextDocumentEdit(
  uriString: string,
  edits: LspTextEdit[],
  expectedVersion?: number | null,
): Promise<void> {
  const uri = monaco.Uri.parse(uriString);
  const model = monaco.editor.getModel(uri);
  if (model) {
    if (expectedVersion != null && model.getVersionId() !== expectedVersion) {
      throw new Error(
        `Document changed before edit: ${uri.fsPath || uri.toString()}`,
      );
    }
    model.pushEditOperations(
      [],
      edits.map((edit) => ({
        range: toMonacoRange(edit.range),
        text: edit.newText,
      })),
      () => null,
    );
    return;
  }
  if (expectedVersion != null)
    throw new Error(`Versioned document is not open: ${uri.toString()}`);
  if (uri.scheme !== "file")
    throw new Error(`Cannot edit unopened URI: ${uri.toString()}`);
  const original = await window.logos.fs.readFile(uri.fsPath);
  await window.logos.fs.writeFile(
    uri.fsPath,
    applyLspTextEdits(original, edits),
  );
}

function protocolTextEdits(
  edits: Array<
    LspTextEdit | { range: LspRange; snippet: { value: string } }
  >,
): LspTextEdit[] {
  return edits.map((edit) =>
    "newText" in edit
      ? edit
      : { range: edit.range, newText: edit.snippet.value },
  );
}

async function closeEditedResource(uri: monaco.Uri) {
  const model = monaco.editor.getModel(uri);
  const tabId = `file:${uri.fsPath}`;
  const tab = useStore.getState().tabs.find((item) => item.id === tabId);
  const wasOpen = Boolean(tab);
  if (model) {
    if (tab?.dirty) {
      await window.logos.fs.writeFile(uri.fsPath, model.getValue());
    }
    lspCloseDoc(uri.fsPath);
    model.dispose();
  }
  if (wasOpen) useStore.getState().closeTab(tabId);
  return wasOpen;
}

async function closeEditedResourceTree(uri: monaco.Uri): Promise<string[]> {
  const root = uri.fsPath.replaceAll("\\", "/").replace(/\/$/, "");
  const paths = new Set<string>();
  const addIfWithin = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    if (normalized === root || normalized.startsWith(`${root}/`)) paths.add(path);
  };
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === "file") addIfWithin(model.uri.fsPath);
  }
  for (const tab of useStore.getState().tabs) {
    if (tab.kind === "file" && tab.path) addIfWithin(tab.path);
  }
  const reopened: string[] = [];
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    if (await closeEditedResource(monaco.Uri.file(path))) {
      reopened.push(path.replaceAll("\\", "/").slice(root.length));
    }
  }
  return reopened;
}

export function prepareUserResourceOperation(path: string): Promise<string[]> {
  return closeEditedResourceTree(monaco.Uri.file(path));
}

export function reopenUserResourceOperation(path: string, suffixes: string[]) {
  for (const suffix of suffixes) useStore.getState().openFile(`${path}${suffix}`);
}

async function confirmChangeAnnotation(
  edit: LspWorkspaceEdit,
  annotationId: string | undefined,
  confirmed: Set<string>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Workspace edit canceled");
  if (!annotationId || confirmed.has(annotationId)) return;
  const annotation = edit.changeAnnotations?.[annotationId];
  if (!annotation?.needsConfirmation) return;
  const accepted = await new Promise<boolean>((resolve) => {
    window.dispatchEvent(
      new CustomEvent("logos:lsp-message-request", {
        detail: {
          type: 3,
          message: [annotation.label, annotation.description]
            .filter(Boolean)
            .join("\n\n"),
          actions: [{ title: "Apply" }],
          signal,
          resolve: (action: { title?: string } | null) =>
            resolve(action?.title === "Apply"),
        },
      }),
    );
  });
  if (!accepted) throw new Error(`Workspace edit declined: ${annotation.label}`);
  confirmed.add(annotationId);
}

async function confirmUnsafeResourceOperation(
  paths: string[],
  action: string,
  signal?: AbortSignal,
) {
  const state = useStore.getState();
  const root = state.root?.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedPaths = paths.map((item) =>
    item.replaceAll("\\", "/").replace(/\/$/, ""),
  );
  const dirty = state.tabs.some((tab) => {
    if (tab.kind !== "file" || !tab.path || !tab.dirty) return false;
    const tabPath = tab.path.replaceAll("\\", "/");
    return normalizedPaths.some(
      (item) => tabPath === item || tabPath.startsWith(`${item}/`),
    );
  });
  const outsideWorkspace = paths.some((item) => {
    const normalized = item.replaceAll("\\", "/");
    return !root || (normalized !== root && !normalized.startsWith(`${root}/`));
  });
  if (!dirty && !outsideWorkspace) return;
  const accepted = await new Promise<boolean>((resolve) => {
    window.dispatchEvent(
      new CustomEvent("logos:lsp-message-request", {
        detail: {
          type: 2,
          message: `${action}\n\n${paths.join("\n")}${
            dirty ? "\n\nThis operation affects unsaved changes." : ""
          }`,
          actions: [{ title: "Apply" }],
          signal,
          resolve: (choice: { title?: string } | null) =>
            resolve(choice?.title === "Apply"),
        },
      }),
    );
  });
  if (!accepted) throw new Error(`Workspace resource operation declined: ${action}`);
}

async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  signal?: AbortSignal,
): Promise<void> {
  const confirmedAnnotations = new Set<string>();
  for (const [uri, changes] of Object.entries(edit.changes ?? {})) {
    if (signal?.aborted) throw new Error("Workspace edit canceled");
    await applyTextDocumentEdit(uri, changes);
  }
  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) {
      for (const textEdit of change.edits) {
        await confirmChangeAnnotation(
          edit,
          "annotationId" in textEdit ? textEdit.annotationId : undefined,
          confirmedAnnotations,
          signal,
        );
      }
      await applyTextDocumentEdit(
        change.textDocument.uri,
        protocolTextEdits(change.edits),
        change.textDocument.version,
      );
      continue;
    }
    if (change.kind === "create") {
      if (signal?.aborted) throw new Error("Workspace edit canceled");
      await confirmChangeAnnotation(
        edit,
        change.annotationId,
        confirmedAnnotations,
        signal,
      );
      const uri = monaco.Uri.parse(change.uri);
      if (uri.scheme !== "file")
        throw new Error(`Cannot create URI: ${uri.toString()}`);
      const exists = await window.logos.fs.exists(uri.fsPath);
      await confirmUnsafeResourceOperation(
        [uri.fsPath],
        "Create a file outside the workspace?",
        signal,
      );
      if (exists && !change.options?.overwrite) {
        if (change.options?.ignoreIfExists) continue;
        throw new Error(`File already exists: ${uri.fsPath}`);
      }
      const model = monaco.editor.getModel(uri);
      if (model) model.setValue("");
      await window.logos.lsp.resourceOperation({ kind: "create", path: uri.fsPath });
      continue;
    }
    if (change.kind === "rename") {
      if (signal?.aborted) throw new Error("Workspace edit canceled");
      await confirmChangeAnnotation(
        edit,
        change.annotationId,
        confirmedAnnotations,
        signal,
      );
      const oldUri = monaco.Uri.parse(change.oldUri);
      const newUri = monaco.Uri.parse(change.newUri);
      if (oldUri.scheme !== "file" || newUri.scheme !== "file")
        throw new Error(`Cannot rename non-file URI: ${change.oldUri}`);
      await confirmUnsafeResourceOperation(
        [oldUri.fsPath, newUri.fsPath],
        "Rename these resources?",
        signal,
      );
      const targetExists = await window.logos.fs.exists(newUri.fsPath);
      if (targetExists && !change.options?.overwrite) {
        if (change.options?.ignoreIfExists) continue;
        throw new Error(`Rename target already exists: ${newUri.fsPath}`);
      }
      const reopened = await closeEditedResourceTree(oldUri);
      const targetReopened = targetExists
        ? await closeEditedResourceTree(newUri)
        : [];
      try {
        await window.logos.lsp.resourceOperation({
          kind: "rename",
          from: oldUri.fsPath,
          to: newUri.fsPath,
          overwrite: Boolean(change.options?.overwrite),
        });
      } catch (error) {
        for (const suffix of reopened) {
          useStore.getState().openFile(`${oldUri.fsPath}${suffix}`);
        }
        for (const suffix of targetReopened) {
          useStore.getState().openFile(`${newUri.fsPath}${suffix}`);
        }
        throw error;
      }
      for (const suffix of reopened) {
        useStore.getState().openFile(`${newUri.fsPath}${suffix}`);
      }
      continue;
    }
    if (change.kind === "delete") {
      if (signal?.aborted) throw new Error("Workspace edit canceled");
      await confirmChangeAnnotation(
        edit,
        change.annotationId,
        confirmedAnnotations,
        signal,
      );
      const uri = monaco.Uri.parse(change.uri);
      if (uri.scheme !== "file")
        throw new Error(`Cannot delete URI: ${uri.toString()}`);
      const exists = await window.logos.fs.exists(uri.fsPath);
      await confirmUnsafeResourceOperation(
        [uri.fsPath],
        "Delete this resource?",
        signal,
      );
      if (!exists) {
        if (change.options?.ignoreIfNotExists) continue;
        throw new Error(`File does not exist: ${uri.fsPath}`);
      }
      const stat = await window.logos.fs.stat(uri.fsPath);
      if (stat.type === "directory" && !change.options?.recursive) {
        if (!(await window.logos.lsp.directoryIsEmpty(uri.fsPath)))
          throw new Error(`Recursive delete was not requested: ${uri.fsPath}`);
      }
      await closeEditedResourceTree(uri);
      await window.logos.lsp.resourceOperation({ kind: "delete", path: uri.fsPath });
    }
  }
}

const pendingNavigation = new Map<string, monaco.IRange | monaco.IPosition>();

export interface LspWorkspaceSymbolResult {
  name: string;
  containerName?: string;
  path: string;
  range: monaco.IRange;
}

export interface LspSymbolResult {
  name: string;
  detail?: string;
  path: string;
  range: monaco.IRange;
  loadChildren?: () => Promise<LspSymbolResult[]>;
}

interface LspHierarchyItem {
  name: string;
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  [key: string]: unknown;
}

function hierarchyResult(item: LspHierarchyItem): LspSymbolResult {
  const uri = monaco.Uri.parse(item.uri);
  return {
    name: item.name,
    detail: item.detail,
    path: uri.fsPath,
    range: toMonacoRange(item.selectionRange ?? item.range),
  };
}

export async function showLspHierarchy(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  kind: "incoming" | "outgoing" | "supertypes" | "subtypes",
) {
  const isCall = kind === "incoming" || kind === "outgoing";
  const capabilityKey = isCall ? "callHierarchyProvider" : "typeHierarchyProvider";
  const prepareMethod = isCall
    ? "textDocument/prepareCallHierarchy"
    : "textDocument/prepareTypeHierarchy";
  const prepared = await requestForModel<LspHierarchyItem[]>(
    model,
    capabilityKey,
    prepareMethod,
    { position: lspPos(position) },
  );
  const item = prepared?.result[0];
  if (!prepared || !item) {
    notifyInfo("No hierarchy is available at this position");
    return;
  }
  const method = isCall ? `callHierarchy/${kind}Calls` : `typeHierarchy/${kind}`;
  const convert = (values: unknown[]): LspSymbolResult[] => values.map((value) => {
    let hierarchyItem: LspHierarchyItem;
    let incomingRange: LspRange | undefined;
    if (kind === "incoming") {
      const incoming = value as {
        from: LspHierarchyItem;
        fromRanges?: LspRange[];
      };
      hierarchyItem = incoming.from;
      incomingRange = incoming.fromRanges?.[0];
    } else if (kind === "outgoing") {
      hierarchyItem = (value as { to: LspHierarchyItem }).to;
    } else {
      hierarchyItem = value as LspHierarchyItem;
    }
    const converted = hierarchyResult(hierarchyItem);
    if (incomingRange) converted.range = toMonacoRange(incomingRange);
    converted.loadChildren = async () =>
      convert(
        await requestLspWithPartialResults<unknown>(prepared.serverId, method, {
          item: hierarchyItem,
        }),
      );
    return converted;
  });
  const show = (items: LspSymbolResult[]) => {
    window.dispatchEvent(
      new CustomEvent("logos:lsp-symbol-results", {
        detail: {
          title: {
            incoming: "Incoming Calls",
            outgoing: "Outgoing Calls",
            supertypes: "Supertypes",
            subtypes: "Subtypes",
          }[kind],
          items,
        },
      }),
    );
  };
  const preview: LspSymbolResult[] = [];
  const response = await requestLspWithPartialResults<unknown>(
    prepared.serverId,
    method,
    { item },
    undefined,
    (partial) => {
      preview.push(...convert(partial));
      show([...preview]);
    },
  );
  show(convert(response));
}

export async function showLspMonikers(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
) {
  const supported = capability(model, "monikerProvider");
  const monikers = supported
    ? await requestLspWithPartialResults<{
        scheme: string;
        identifier: string;
        unique?: string;
        kind?: string;
      }>(supported.serverId, "textDocument/moniker", {
        textDocument: { uri: model.uri.toString() },
        position: lspPos(position),
      })
    : [];
  if (!monikers.length) {
    notifyInfo("No moniker is available at this position");
    return;
  }
  notifyInfo(
    "Symbol Monikers",
    monikers
      .map((moniker) => `${moniker.scheme}:${moniker.identifier}`)
      .join("\n"),
  );
}

export function openLspSymbolResult(result: LspSymbolResult) {
  pendingNavigation.set(result.path, result.range);
  window.dispatchEvent(
    new CustomEvent("logos:lsp-navigate", {
      detail: { path: result.path, target: result.range },
    }),
  );
  useStore.getState().openFile(result.path);
}

function openLocationsInMultiBuffer(
  id: string,
  title: string,
  kind: "reference" | "definition",
  locations: Array<{ uri: monaco.Uri; range: monaco.IRange }>,
) {
  if (!locations.length) {
    notifyInfo(`No ${title.toLocaleLowerCase()} found`);
    return;
  }
  useStore.getState().openMultiBuffer(
    createMultiBufferDocument(
      id,
      title,
      kind,
      locations.map((location, index) => ({
        id: `${location.uri.fsPath}:${location.range.startLineNumber}:${location.range.startColumn}:${index}`,
        path: location.uri.fsPath,
        startLine: location.range.startLineNumber,
        startColumn: location.range.startColumn,
        endLine: location.range.endLineNumber,
        endColumn: location.range.endColumn,
      })),
    ),
  );
}

export async function showLspReferencesInMultiBuffer(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
) {
  const response = await requestForModel<LspLocation[]>(
    model,
    "referencesProvider",
    "textDocument/references",
    {
      position: lspPos(position),
      context: { includeDeclaration: true },
    },
  );
  openLocationsInMultiBuffer(
    `references:${model.uri.toString()}:${position.lineNumber}:${position.column}`,
    "References",
    "reference",
    toLocations(response?.result ?? null),
  );
}

export async function showLspDefinitionsInMultiBuffer(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  typeDefinition = false,
) {
  const title = typeDefinition ? "Type Definitions" : "Definitions";
  const response = await requestForModel<unknown>(
    model,
    typeDefinition ? "typeDefinitionProvider" : "definitionProvider",
    typeDefinition ? "textDocument/typeDefinition" : "textDocument/definition",
    { position: lspPos(position) },
  );
  const links = toLocationLinks(response?.result);
  openLocationsInMultiBuffer(
    `${typeDefinition ? "type-definitions" : "definitions"}:${model.uri.toString()}:${position.lineNumber}:${position.column}`,
    title,
    "definition",
    (links ?? []).map((link) => ({
      uri: link.uri,
      range: link.targetSelectionRange ?? link.range,
    })),
  );
}

export async function lspWorkspaceSymbols(
  query: string,
  signal?: AbortSignal,
  onPartial?: (symbols: LspWorkspaceSymbolResult[]) => void,
): Promise<LspWorkspaceSymbolResult[]> {
  const token = cancellationTokenForSignal(signal);
  const results: LspWorkspaceSymbolResult[] = [];
  for (const serverId of startedServers) {
    if (signal?.aborted) break;
    const staticOptions = serverCapability(serverId, "workspaceSymbolProvider");
    const dynamic = [...(dynamicRegistrations.get(serverId)?.values() ?? [])].find(
      (registration) => registration.method === "workspace/symbol",
    );
    if (!staticOptions && !dynamic) continue;
    const preview: LspWorkspaceSymbolResult[] = [];
    const symbols = await requestLspWithPartialResults<SymbolInformation>(
      serverId,
      "workspace/symbol",
      { query },
      token,
      (partial) => {
        const converted = partial.flatMap((symbol) => {
          const location = symbol.location;
          if (!location || !("range" in location)) return [];
          const uri = monaco.Uri.parse(location.uri);
          if (uri.scheme !== "file") return [];
          return [{
            name: symbol.name,
            containerName: symbol.containerName,
            path: uri.fsPath,
            range: toMonacoRange(location.range),
          }];
        });
        preview.push(...converted);
        if (converted.length) onPartial?.([...results, ...preview]);
      },
    );
    for (let symbol of symbols) {
      let location = symbol.location;
      if (
        (!location || !("range" in location)) &&
        typeof staticOptions === "object" &&
        staticOptions.resolveProvider
      ) {
        symbol = await requestLsp<SymbolInformation>(
          serverId,
          "workspaceSymbol/resolve",
          symbol,
          token,
        ).catch(() => symbol);
        location = symbol.location;
      }
      if (!location || !("range" in location)) continue;
      const uri = monaco.Uri.parse(location.uri);
      if (uri.scheme !== "file") continue;
      results.push({
        name: symbol.name,
        containerName: symbol.containerName,
        path: uri.fsPath,
        range: toMonacoRange(location.range),
      });
    }
  }
  return results;
}

export function openLspWorkspaceSymbol(symbol: LspWorkspaceSymbolResult) {
  pendingNavigation.set(symbol.path, symbol.range);
  window.dispatchEvent(
    new CustomEvent("logos:lsp-navigate", {
      detail: { path: symbol.path, target: symbol.range },
    }),
  );
  useStore.getState().openFile(symbol.path);
}

export function takeLspNavigationTarget(
  path: string,
): monaco.IRange | monaco.IPosition | undefined {
  const target = pendingNavigation.get(path);
  pendingNavigation.delete(path);
  return target;
}

const linkResolveLinks = new WeakMap<
  monaco.languages.ILink,
  { serverId: string; raw: DocumentLink; resolveProvider: boolean }
>();
const codeLensResolveLinks = new WeakMap<
  monaco.languages.CodeLens,
  { serverId: string; raw: LspCodeLens; resolveProvider: boolean }
>();
const inlayResolveLinks = new WeakMap<
  monaco.languages.InlayHint,
  { serverId: string; raw: LspInlayHint; resolveProvider: boolean }
>();

function publishDiagnostics(
  serverId: string,
  uriString: string,
  diagnostics: LspDiagnostic[],
  version?: number | null,
) {
  const uri = monaco.Uri.parse(uriString);
  const model = monaco.editor.getModel(uri);
  if (version != null && model && model.getVersionId() !== version) return;

  publishedDiagnostics.set(uriString, diagnostics);
  diagnosticOwners.set(uriString, serverId);
  const markers: monaco.editor.IMarkerData[] = diagnostics.map((diagnostic) => ({
    message: markupValue(diagnostic.message),
    severity: severityToMonaco(diagnostic.severity ?? 1),
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    source: diagnostic.source,
    code:
      diagnostic.code == null
        ? undefined
        : diagnostic.codeDescription
          ? {
              value: String(diagnostic.code),
              target: monaco.Uri.parse(diagnostic.codeDescription.href),
            }
          : String(diagnostic.code),
    tags: diagnostic.tags as monaco.MarkerTag[] | undefined,
    relatedInformation: diagnostic.relatedInformation?.map((related) => ({
      resource: monaco.Uri.parse(related.location.uri),
      message: related.message,
      startLineNumber: related.location.range.start.line + 1,
      startColumn: related.location.range.start.character + 1,
      endLineNumber: related.location.range.end.line + 1,
      endColumn: related.location.range.end.character + 1,
    })),
  }));
  if (model) monaco.editor.setModelMarkers(model, "logos-lsp", markers);

  const stored: Diagnostic[] = diagnostics.map((diagnostic) => ({
    message: markupValue(diagnostic.message),
    severity: diagnostic.severity ?? 1,
    startLine: diagnostic.range.start.line + 1,
    startCol: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endCol: diagnostic.range.end.character + 1,
    source: diagnostic.source,
  }));
  useStore.getState().setDiagnostics(uri.fsPath, stored);
}

type DocumentDiagnosticReport = {
  kind: "full" | "unchanged";
  resultId?: string;
  items?: LspDiagnostic[];
  relatedDocuments?: Record<
    string,
    { kind: "full" | "unchanged"; resultId?: string; items?: LspDiagnostic[] }
  >;
};

async function pullDocumentDiagnostics(model: monaco.editor.ITextModel) {
  const supported = capability(model, "diagnosticProvider");
  if (!supported || openDocs.get(model.uri.fsPath) !== supported.serverId) return;
  const uri = model.uri.toString();
  const key = diagnosticKey(supported.serverId, uri);
  const generation = (diagnosticRequestGenerations.get(key) ?? 0) + 1;
  const version = model.getVersionId();
  diagnosticRequestGenerations.set(key, generation);
  diagnosticControllers.get(key)?.abort();
  const controller = new AbortController();
  diagnosticControllers.set(key, controller);
  const report = await requestLsp<DocumentDiagnosticReport>(
    supported.serverId,
    "textDocument/diagnostic",
    {
      textDocument: { uri },
      identifier:
        typeof supported.value === "object" ? supported.value.identifier : undefined,
      previousResultId: diagnosticResultIds.get(key),
    },
    cancellationTokenForSignal(controller.signal),
  ).catch(() => null);
  if (diagnosticControllers.get(key) === controller) {
    diagnosticControllers.delete(key);
  }
  if (
    !report ||
    diagnosticRequestGenerations.get(key) !== generation ||
    model.isDisposed() ||
    model.getVersionId() !== version
  ) {
    if (!model.isDisposed() && model.getVersionId() !== version) {
      scheduleDocumentDiagnostics(model);
    }
    return;
  }
  if (report.resultId) diagnosticResultIds.set(key, report.resultId);
  else if (report.kind === "full") diagnosticResultIds.delete(key);
  if (report.kind === "full") {
    publishDiagnostics(supported.serverId, uri, report.items ?? []);
  }
  for (const [relatedUri, related] of Object.entries(report.relatedDocuments ?? {})) {
    if (related.resultId) {
      diagnosticResultIds.set(
        diagnosticKey(supported.serverId, relatedUri),
        related.resultId,
      );
    } else if (related.kind === "full") {
      diagnosticResultIds.delete(diagnosticKey(supported.serverId, relatedUri));
    }
    if (related.kind === "full") {
      publishDiagnostics(supported.serverId, relatedUri, related.items ?? []);
    }
  }
}

function scheduleDocumentDiagnostics(model: monaco.editor.ITextModel, delay = 400) {
  const uri = model.uri.toString();
  const current = diagnosticTimers.get(uri);
  if (current) clearTimeout(current);
  diagnosticTimers.set(
    uri,
    setTimeout(() => {
      diagnosticTimers.delete(uri);
      void pullDocumentDiagnostics(model);
    }, delay),
  );
}

type WorkspaceDiagnosticItem = {
  uri: string;
  version?: number | null;
  kind: "full" | "unchanged";
  resultId?: string;
  items?: LspDiagnostic[];
};

function applyWorkspaceDiagnosticItems(
  serverId: string,
  items: WorkspaceDiagnosticItem[],
) {
  for (const item of items) {
    if (item.resultId) {
      diagnosticResultIds.set(diagnosticKey(serverId, item.uri), item.resultId);
    } else if (item.kind === "full") {
      diagnosticResultIds.delete(diagnosticKey(serverId, item.uri));
    }
    if (item.kind === "full") {
      publishDiagnostics(serverId, item.uri, item.items ?? [], item.version);
    }
  }
}

async function pullWorkspaceDiagnostics(serverId: string) {
  const existingTimer = workspaceDiagnosticTimers.get(serverId);
  if (existingTimer) clearTimeout(existingTimer);
  workspaceDiagnosticTimers.delete(serverId);
  workspaceDiagnosticControllers.get(serverId)?.abort();
  const controller = new AbortController();
  workspaceDiagnosticControllers.set(serverId, controller);
  const options = serverCapability(serverId, "diagnosticProvider");
  if (!options || typeof options !== "object" || !options.workspaceDiagnostics) {
    workspaceDiagnosticControllers.delete(serverId);
    return;
  }
  const generation = (workspaceDiagnosticGenerations.get(serverId) ?? 0) + 1;
  workspaceDiagnosticGenerations.set(serverId, generation);
  const partialResultToken = `logos:diagnostics:${serverId}:${nextRequestId}`;
  const partialKey = `${serverId}:${partialResultToken}`;
  partialResultHandlers.set(partialKey, (value) => {
    if (
      workspaceDiagnosticGenerations.get(serverId) !== generation ||
      !startedServers.has(serverId)
    ) return;
    const items = (value as { items?: WorkspaceDiagnosticItem[] })?.items;
    if (items) applyWorkspaceDiagnosticItems(serverId, items);
  });
  try {
    const result = await requestLsp<{ items?: WorkspaceDiagnosticItem[] }>(
      serverId,
      "workspace/diagnostic",
      {
        identifier: options.identifier,
        previousResultIds: [...diagnosticResultIds]
          .filter(([key]) => key.startsWith(`${serverId}\u0000`))
          .map(([key, value]) => ({
            uri: key.slice(serverId.length + 1),
            value,
          })),
        partialResultToken,
      },
      cancellationTokenForSignal(controller.signal),
    ).catch(() => null);
    if (
      result?.items &&
      workspaceDiagnosticGenerations.get(serverId) === generation &&
      startedServers.has(serverId)
    ) {
      applyWorkspaceDiagnosticItems(serverId, result.items);
    }
  } finally {
    partialResultHandlers.delete(partialKey);
    if (workspaceDiagnosticControllers.get(serverId) === controller) {
      workspaceDiagnosticControllers.delete(serverId);
    }
    if (startedServers.has(serverId) && !controller.signal.aborted) {
      workspaceDiagnosticTimers.set(
        serverId,
        setTimeout(() => {
          workspaceDiagnosticTimers.delete(serverId);
          void pullWorkspaceDiagnostics(serverId);
        }, 60_000),
      );
    }
  }
}

let providersRegistered = false;

export function setupLspMonaco() {
  if (providersRegistered) return;
  providersRegistered = true;

  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      if (source.getModel()?.uri.toString() === resource.toString()) {
        if (selectionOrPosition && "startLineNumber" in selectionOrPosition) {
          source.setSelection(selectionOrPosition);
          source.revealRangeInCenter(selectionOrPosition);
        } else if (selectionOrPosition) {
          source.setPosition(selectionOrPosition);
          source.revealPositionInCenter(selectionOrPosition);
        }
        source.focus();
        return true;
      }
      if (selectionOrPosition)
        pendingNavigation.set(resource.fsPath, selectionOrPosition);
      useStore.getState().openFile(resource.fsPath);
      return true;
    },
  });
  monaco.editor.registerCommand(
    "logos.lsp.executeCommand",
    (_accessor, serverId: string, command: LspCommand) =>
      window.logos.lsp.request(serverId, "workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      }),
  );
  monaco.editor.registerCommand(
    "logos.lsp.applyCodeAction",
    async (
      _accessor,
      serverId: string,
      action: LspCodeAction,
      resolveProvider: boolean,
    ) => {
      let resolved = action;
      if (resolveProvider && action.data) {
        resolved = (await window.logos.lsp
          .request(serverId, "codeAction/resolve", action)
          .catch(() => action)) as LspCodeAction;
      }
      if (resolved.edit) await applyWorkspaceEdit(resolved.edit);
      if (resolved.command) {
        await window.logos.lsp.request(serverId, "workspace/executeCommand", {
          command: resolved.command.command,
          arguments: resolved.command.arguments,
        });
      }
    },
  );

  // Monaco bundles its own TS/JS language service (the `typescript` worker). It
  // type-checks WITHOUT the workspace's node_modules or tsconfig, so it emits
  // false "Cannot find module 'react'" (2792) errors and would duplicate the
  // completions/hovers/definitions the providers below already forward to the
  // real language server. This editor is LSP-first, so silence the built-in
  // worker's diagnostics + the features the bridge owns. setModeConfiguration
  // REPLACES (does not merge), so spread the current config to keep the
  // syntactic fallbacks (outline, occurrence highlight, rename, signature help)
  // on; colorization is a separate subsystem and is unaffected either way.
  //
  // NB: read the worker defaults from the top-level `monaco.typescript`/`.json`/
  // `.css` namespaces. In monaco 0.55 the older `monaco.languages.*` accessors
  // are deprecated stubs (typed `{ deprecated: true }`); the real defaults live
  // at the top level.
  const tsLangs = monaco.typescript;
  if (tsLangs) {
    for (const d of [tsLangs.typescriptDefaults, tsLangs.javascriptDefaults]) {
      d.setModeConfiguration({
        ...d.modeConfiguration,
        diagnostics: false,
        completionItems: false,
        hovers: false,
        definitions: false,
        documentSymbols: false,
        references: false,
        documentHighlights: false,
        rename: false,
        documentRangeFormattingEdits: false,
        signatureHelp: false,
        onTypeFormattingEdits: false,
        codeActions: false,
        inlayHints: false,
      });
      d.setDiagnosticsOptions({
        ...d.getDiagnosticsOptions(),
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
    }
  }

  // Same LSP-first reasoning for the bundled JSON worker: it validates against
  // its built-in schemas and reports comments (e.g. in tsconfig.json) as errors
  // — false positives for an editor that defers to the json language server —
  // and its completions/hovers duplicate the ones the bridge below forwards.
  // `validate: false` silences the diagnostics; mode config drops the duplicate
  // providers while keeping outline (documentSymbols), tokens, and colors.
  const jsonLang = monaco.json;
  if (jsonLang) {
    jsonLang.jsonDefaults.setDiagnosticsOptions({
      ...jsonLang.jsonDefaults.diagnosticsOptions,
      validate: false,
    });
    jsonLang.jsonDefaults.setModeConfiguration({
      ...jsonLang.jsonDefaults.modeConfiguration,
      diagnostics: false,
      completionItems: false,
      hovers: false,
      documentSymbols: false,
      colors: false,
      foldingRanges: false,
      selectionRanges: false,
      documentFormattingEdits: false,
      documentRangeFormattingEdits: false,
    });
  }

  // ...and the CSS/SCSS/LESS workers: their linter flags vendor prefixes, unknown
  // properties, and at-rules like Tailwind's `@apply`/`@tailwind` as errors on
  // otherwise-valid stylesheets. Defer to the css language server: kill
  // validation (`setOptions`) and the duplicate providers, keep color decorators
  // and folding ranges (`colors`/`foldingRanges` left untouched).
  const cssLang = monaco.css;
  if (cssLang) {
    for (const d of [
      cssLang.cssDefaults,
      cssLang.scssDefaults,
      cssLang.lessDefaults,
    ]) {
      d.setOptions({ ...d.options, validate: false });
      d.setModeConfiguration({
        ...d.modeConfiguration,
        diagnostics: false,
        completionItems: false,
        hovers: false,
        definitions: false,
        references: false,
        documentHighlights: false,
        rename: false,
        documentSymbols: false,
        colors: false,
        foldingRanges: false,
        selectionRanges: false,
        documentFormattingEdits: false,
        documentRangeFormattingEdits: false,
      });
    }
  }

  const htmlLang = monaco.html;
  if (htmlLang) {
    htmlLang.htmlDefaults.setModeConfiguration({
      ...htmlLang.htmlDefaults.modeConfiguration,
      completionItems: false,
      hovers: false,
      documentSymbols: false,
      links: false,
      documentHighlights: false,
      rename: false,
      colors: false,
      foldingRanges: false,
      diagnostics: false,
      selectionRanges: false,
      documentFormattingEdits: false,
      documentRangeFormattingEdits: false,
    });
  }

  monaco.languages.registerCompletionItemProvider(MONACO_LANGS, {
    triggerCharacters: [...`!\"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~ `],
    async provideCompletionItems(model, position, context, token) {
      const supported = capability(model, "completionProvider");
      if (!supported) return { suggestions: [] };
      const { serverId } = supported;
      const triggerCharacter = context.triggerCharacter;
      const validTrigger =
        context.triggerKind !==
          monaco.languages.CompletionTriggerKind.TriggerCharacter ||
        (triggerCharacter != null &&
          supported.value.triggerCharacters?.includes(triggerCharacter));
      const res = (await requestLsp<
        { items?: unknown[]; isIncomplete?: boolean } | unknown[] | null
      >(serverId, "textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: lspPos(position),
          // C2: forward the trigger context so servers distinguish `.`-style
          // member completion from a plain invocation.
          context: {
            triggerKind: validTrigger ? lspTriggerKind(context.triggerKind) : 1,
            triggerCharacter: validTrigger ? triggerCharacter : undefined,
          },
        }, token)
        .catch(() => null)) as
        | { items?: unknown[]; isIncomplete?: boolean }
        | unknown[]
        | null;
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      // C2: preserve isIncomplete so Monaco re-queries while the user types
      // instead of filtering a stale first page.
      const incomplete = !Array.isArray(res) && Boolean(res?.isIncomplete);
      const word = model.getWordUntilPosition(position);
      const defaultRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions = (items as Array<Record<string, unknown>>).map((it) => {
        const textEdit = it.textEdit as LspCompletionTextEdit | undefined;
        const editRange = textEdit
          ? (textEdit.range ?? textEdit.replace ?? textEdit.insert)
          : undefined;
        const isSnippet = (it.insertTextFormat as number | undefined) === 2;
        const item: monaco.languages.CompletionItem = {
          label: String(it.label ?? ""),
          kind: COMPLETION_KIND[(it.kind as number) ?? 1] ?? 0,
          // F1: honor the server's textEdit/snippet instead of dumping the
          // label verbatim.
          insertText: String(textEdit?.newText ?? it.insertText ?? it.label ?? ""),
          detail: it.detail as string | undefined,
          documentation: it.documentation
            ? { value: markupValue(it.documentation) }
            : undefined,
          range: editRange ? toMonacoRange(editRange) : defaultRange,
          sortText: it.sortText as string | undefined,
          filterText: it.filterText as string | undefined,
          commitCharacters: it.commitCharacters as string[] | undefined,
          preselect: it.preselect as boolean | undefined,
          tags: it.tags as monaco.languages.CompletionItemTag[] | undefined,
          command: toCommand(serverId, it.command as LspCommand | undefined),
          additionalTextEdits: toMonacoEdits(
            it.additionalTextEdits as LspTextEdit[] | undefined,
          ),
          insertTextRules: isSnippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        };
        resolveLinks.set(item, {
          serverId,
          raw: it,
          resolveProvider:
            typeof supported.value === "object" &&
            Boolean(supported.value.resolveProvider),
        });
        return item;
      });
      return { suggestions, incomplete };
    },
    async resolveCompletionItem(item, token) {
      const link = resolveLinks.get(item);
      if (!link) return item;
      if (!link.resolveProvider) return item;
      const resolved = (await requestLsp<Record<string, unknown>>(
        link.serverId,
        "completionItem/resolve",
        link.raw,
        token,
      )
        .catch(() => null)) as Record<string, unknown> | null;
      if (!resolved) return item;
      if (resolved.detail) item.detail = String(resolved.detail);
      if (resolved.documentation)
        item.documentation = { value: markupValue(resolved.documentation) };
      if (resolved.command)
        item.command = toCommand(
          link.serverId,
          resolved.command as LspCommand,
        );
      const extra = toMonacoEdits(
        resolved.additionalTextEdits as LspTextEdit[] | undefined,
      );
      if (extra) item.additionalTextEdits = extra;
      return item;
    },
  });

  monaco.languages.registerHoverProvider(MONACO_LANGS, {
    async provideHover(model, position, token) {
      const response = await requestForModel<{
        contents?: unknown;
        range?: LspRange;
      }>(
        model,
        "hoverProvider",
        "textDocument/hover",
        { position: lspPos(position) },
        token,
      );
      const res = response?.result;
      if (!res?.contents) return null;
      const value = markupValue(res.contents);
      if (!value) return null;
      return {
        contents: [{ value }],
        range: res.range ? toMonacoRange(res.range) : undefined,
      };
    },
  });

  const navigation = async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    capabilityKey:
      | "definitionProvider"
      | "declarationProvider"
      | "typeDefinitionProvider"
      | "implementationProvider",
    method: string,
    token?: monaco.CancellationToken,
  ) =>
    toLocationLinks(
      (
        await requestForModel<unknown>(model, capabilityKey, method, {
          position: lspPos(position),
        }, token)
      )?.result,
    );

  monaco.languages.registerDefinitionProvider(MONACO_LANGS, {
    provideDefinition: (model, position, token) =>
      navigation(model, position, "definitionProvider", "textDocument/definition", token),
  });
  monaco.languages.registerDeclarationProvider(MONACO_LANGS, {
    provideDeclaration: (model, position, token) =>
      navigation(model, position, "declarationProvider", "textDocument/declaration", token),
  });
  monaco.languages.registerTypeDefinitionProvider(MONACO_LANGS, {
    provideTypeDefinition: (model, position, token) =>
      navigation(
        model,
        position,
        "typeDefinitionProvider",
        "textDocument/typeDefinition",
        token,
      ),
  });
  monaco.languages.registerImplementationProvider(MONACO_LANGS, {
    provideImplementation: (model, position, token) =>
      navigation(
        model,
        position,
        "implementationProvider",
        "textDocument/implementation",
        token,
      ),
  });

  monaco.languages.registerReferenceProvider(MONACO_LANGS, {
    async provideReferences(model, position, context, token) {
      const response = await requestForModel<LspLocation[]>(
        model,
        "referencesProvider",
        "textDocument/references",
        {
          position: lspPos(position),
          context: { includeDeclaration: context.includeDeclaration },
        },
        token,
      );
      return response ? toLocations(response.result) : null;
    },
  });

  monaco.languages.registerDocumentHighlightProvider(MONACO_LANGS, {
    async provideDocumentHighlights(model, position, token) {
      const response = await requestForModel<
        Array<{ range: LspRange; kind?: number }>
      >(
        model,
        "documentHighlightProvider",
        "textDocument/documentHighlight",
        { position: lspPos(position) },
        token,
      );
      return (response?.result ?? []).map((highlight) => ({
        range: toMonacoRange(highlight.range),
        kind:
          highlight.kind == null
            ? undefined
            : (highlight.kind - 1 as monaco.languages.DocumentHighlightKind),
      }));
    },
  });

  const convertDocumentSymbol = (
    symbol: LspDocumentSymbol,
  ): monaco.languages.DocumentSymbol => ({
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: (symbol.kind - 1) as monaco.languages.SymbolKind,
    tags: (symbol.tags ?? []) as monaco.languages.SymbolTag[],
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    children: symbol.children?.map(convertDocumentSymbol),
  });
  monaco.languages.registerDocumentSymbolProvider(MONACO_LANGS, {
    async provideDocumentSymbols(model, token) {
      const response = await requestForModel<
        Array<LspDocumentSymbol | SymbolInformation>
      >(
        model,
        "documentSymbolProvider",
        "textDocument/documentSymbol",
        {},
        token,
      );
      return (response?.result ?? []).map((symbol) => {
        if ("location" in symbol) {
          const range = toMonacoRange(symbol.location.range);
          return {
            name: symbol.name,
            detail: "",
            kind: (symbol.kind - 1) as monaco.languages.SymbolKind,
            tags: (symbol.tags ?? []) as monaco.languages.SymbolTag[],
            containerName: symbol.containerName,
            range,
            selectionRange: range,
          };
        }
        return convertDocumentSymbol(symbol);
      });
    },
  });

  monaco.languages.registerSignatureHelpProvider(MONACO_LANGS, {
    signatureHelpTriggerCharacters: [...`!\"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`],
    signatureHelpRetriggerCharacters: [...`!\"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`],
    async provideSignatureHelp(model, position, token, context) {
      const signatureCapability = capability(model, "signatureHelpProvider");
      if (
        !signatureCapability ||
        (context.triggerKind ===
          monaco.languages.SignatureHelpTriggerKind.TriggerCharacter &&
          (!context.triggerCharacter ||
            !signatureCapability.value.triggerCharacters?.includes(
              context.triggerCharacter,
            )))
      )
        return null;
      const response = await requestForModel<SignatureHelp>(
        model,
        "signatureHelpProvider",
        "textDocument/signatureHelp",
        {
          position: lspPos(position),
          context: {
            triggerKind: context.triggerKind,
            triggerCharacter: context.triggerCharacter,
            isRetrigger: context.isRetrigger,
            activeSignatureHelp: context.activeSignatureHelp
              ? {
                  signatures: context.activeSignatureHelp.signatures.map(
                    (signature) => ({
                      label: signature.label,
                      documentation: signature.documentation
                        ? markupValue(signature.documentation)
                        : undefined,
                      parameters: signature.parameters.map((parameter) => ({
                        label: parameter.label,
                        documentation: parameter.documentation
                          ? markupValue(parameter.documentation)
                          : undefined,
                      })),
                      activeParameter: signature.activeParameter,
                    }),
                  ),
                  activeSignature:
                    context.activeSignatureHelp.activeSignature,
                  activeParameter:
                    context.activeSignatureHelp.activeParameter,
                }
              : undefined,
          },
        },
        token,
      );
      if (!response) return null;
      return {
        value: {
          signatures: response.result.signatures.map((signature) => ({
            label: signature.label,
            documentation: signature.documentation
              ? { value: markupValue(signature.documentation) }
              : undefined,
            parameters: (signature.parameters ?? []).map((parameter) => ({
              label: parameter.label,
              documentation: parameter.documentation
                ? { value: markupValue(parameter.documentation) }
                : undefined,
            })),
            activeParameter: signature.activeParameter ?? undefined,
          })),
          activeSignature: response.result.activeSignature ?? 0,
          activeParameter: response.result.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(MONACO_LANGS, {
    async provideDocumentFormattingEdits(model, options, token) {
      const response = await requestForModel<LspTextEdit[]>(
        model,
        "documentFormattingProvider",
        "textDocument/formatting",
        { options },
        token,
      );
      return toTextEdits(response?.result ?? null);
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(MONACO_LANGS, {
    async provideDocumentRangeFormattingEdits(model, range, options, token) {
      const response = await requestForModel<LspTextEdit[]>(
        model,
        "documentRangeFormattingProvider",
        "textDocument/rangeFormatting",
        { range: lspRange(range), options },
        token,
      );
      return toTextEdits(response?.result ?? null);
    },
  });
  monaco.languages.registerOnTypeFormattingEditProvider(MONACO_LANGS, {
    autoFormatTriggerCharacters: [
      ...`!\"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`,
      "\n",
    ],
    async provideOnTypeFormattingEdits(model, position, ch, options, token) {
      const formatting = capability(model, "documentOnTypeFormattingProvider");
      if (
        !formatting ||
        typeof formatting.value !== "object" ||
        ![
          formatting.value.firstTriggerCharacter,
          ...(formatting.value.moreTriggerCharacter ?? []),
        ].includes(ch)
      )
        return [];
      const response = await requestForModel<LspTextEdit[]>(
        model,
        "documentOnTypeFormattingProvider",
        "textDocument/onTypeFormatting",
        { position: lspPos(position), ch, options },
        token,
      );
      return toTextEdits(response?.result ?? null);
    },
  });

  monaco.languages.registerRenameProvider(MONACO_LANGS, {
    async resolveRenameLocation(model, position, token) {
      const renameCapability = capability(model, "renameProvider");
      const prepareSupported =
        renameCapability &&
        typeof renameCapability.value === "object" &&
        renameCapability.value.prepareProvider;
      const rejected = (reason: string) => ({
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        ),
        text: "",
        rejectReason: reason,
      });
      const defaultLocation = () => {
        const word = model.getWordAtPosition(position);
        return word
          ? {
              range: new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              ),
              text: word.word,
            }
          : rejected("Rename is not valid at this position");
      };
      if (!renameCapability) return rejected("Rename is not supported here");
      if (!prepareSupported) return defaultLocation();
      const response = await requestForModel<
        LspRange | { range?: LspRange; placeholder?: string; defaultBehavior?: boolean }
      >(model, "renameProvider", "textDocument/prepareRename", {
        position: lspPos(position),
      }, token);
      if (!response) return rejected("Rename is not supported here");
      const result = response.result;
      const range = "start" in result ? result : result.range;
      if (!range) {
        if ("defaultBehavior" in result && result.defaultBehavior) {
          return defaultLocation();
        }
        return rejected("Rename is not valid at this position");
      }
      const monacoRange = toMonacoRange(range);
      return {
        range: monacoRange,
        text:
          ("placeholder" in result ? result.placeholder : undefined) ??
          model.getValueInRange(monacoRange),
      };
    },
    async provideRenameEdits(model, position, newName, token) {
      const response = await requestForModel<LspWorkspaceEdit>(
        model,
        "renameProvider",
        "textDocument/rename",
        { position: lspPos(position), newName },
        token,
      );
      if (!response) return { edits: [], rejectReason: "Rename failed" };
      await applyWorkspaceEdit(response.result);
      return { edits: [] };
    },
  });

  const convertCodeAction = async (
    serverId: string,
    raw: LspCodeAction | LspCommand,
    resolveProvider: boolean,
  ): Promise<monaco.languages.CodeAction> => {
    if (typeof raw.command === "string") {
      return {
        title: raw.title,
        command: toCommand(serverId, raw as LspCommand),
      };
    }
    const action = raw as LspCodeAction;
    const converted: monaco.languages.CodeAction = {
      title: action.title,
      kind: action.kind,
      isPreferred: action.isPreferred,
      disabled: action.disabled?.reason,
      command:
        action.disabled
          ? undefined
          : {
              id: "logos.lsp.applyCodeAction",
              title: action.title,
              arguments: [serverId, action, resolveProvider],
            },
    };
    return converted;
  };
  monaco.languages.registerCodeActionProvider(MONACO_LANGS, {
    async provideCodeActions(model, range, context, token) {
      const requestedRange = lspRange(range);
      const diagnostics = (publishedDiagnostics.get(model.uri.toString()) ?? []).filter(
        (diagnostic) =>
          diagnostic.range.start.line <= requestedRange.end.line &&
          diagnostic.range.end.line >= requestedRange.start.line,
      );
      const response = await requestForModel<Array<LspCodeAction | LspCommand>>(
        model,
        "codeActionProvider",
        "textDocument/codeAction",
        {
          range: lspRange(range),
          context: {
            diagnostics,
            only: context.only ? [context.only] : undefined,
            triggerKind: context.trigger,
          },
        },
        token,
      );
      const codeActionOptions = capability(model, "codeActionProvider")?.value;
      const resolveProvider =
        typeof codeActionOptions === "object" &&
        Boolean(codeActionOptions.resolveProvider);
      const actions = response
        ? await Promise.all(
            response.result.map((action) =>
              convertCodeAction(
                response.serverId,
                action,
                resolveProvider,
              ),
            ),
          )
        : [];
      return { actions, dispose() {} };
    },
  });

  monaco.languages.registerLinkProvider(MONACO_LANGS, {
    async provideLinks(model, token) {
      const response = await requestForModel<DocumentLink[]>(
        model,
        "documentLinkProvider",
        "textDocument/documentLink",
        {},
        token,
      );
      const links = (response?.result ?? []).map((raw) => {
        const link: monaco.languages.ILink = {
          range: toMonacoRange(raw.range),
          url: raw.target,
          tooltip: raw.tooltip,
        };
        const options = capability(model, "documentLinkProvider")?.value;
        if (response) {
          linkResolveLinks.set(link, {
            serverId: response.serverId,
            raw,
            resolveProvider:
              typeof options === "object" && Boolean(options.resolveProvider),
          });
        }
        return link;
      });
      return { links };
    },
    async resolveLink(link, token) {
      const source = linkResolveLinks.get(link);
      if (!source) return link;
      if (!source.resolveProvider) return link;
      const resolved = (await requestLsp<DocumentLink>(
        source.serverId,
        "documentLink/resolve",
        source.raw,
        token,
      )
        .catch(() => null)) as DocumentLink | null;
      if (!resolved) return link;
      link.url = resolved.target;
      link.tooltip = resolved.tooltip;
      return link;
    },
  });

  monaco.languages.registerFoldingRangeProvider(MONACO_LANGS, {
    async provideFoldingRanges(model, _context, token) {
      const response = await requestForModel<LspFoldingRange[]>(
        model,
        "foldingRangeProvider",
        "textDocument/foldingRange",
        {},
        token,
      );
      return (response?.result ?? []).map((range) => ({
        start: range.startLine + 1,
        end: range.endLine + 1,
        kind: range.kind
          ? monaco.languages.FoldingRangeKind.fromValue(range.kind)
          : undefined,
      }));
    },
  });

  monaco.languages.registerSelectionRangeProvider(MONACO_LANGS, {
    async provideSelectionRanges(model, positions, token) {
      const response = await requestForModel<LspSelectionRange[]>(
        model,
        "selectionRangeProvider",
        "textDocument/selectionRange",
        { positions: positions.map(lspPos) },
        token,
      );
      return (response?.result ?? []).map((selection) => {
        const ranges: monaco.languages.SelectionRange[] = [];
        for (
          let current: LspSelectionRange | undefined = selection;
          current;
          current = current.parent
        ) {
          ranges.push({ range: toMonacoRange(current.range) });
        }
        return ranges;
      });
    },
  });

  monaco.languages.registerLinkedEditingRangeProvider(MONACO_LANGS, {
    async provideLinkedEditingRanges(model, position, token) {
      const response = await requestForModel<LinkedEditingRanges>(
        model,
        "linkedEditingRangeProvider",
        "textDocument/linkedEditingRange",
        { position: lspPos(position) },
        token,
      );
      if (!response) return null;
      let wordPattern: RegExp | undefined;
      if (
        response.result.wordPattern &&
        isSafeWordPattern(response.result.wordPattern)
      ) {
        try {
          wordPattern = new RegExp(response.result.wordPattern);
        } catch {
          wordPattern = undefined;
        }
      }
      return {
        ranges: response.result.ranges.map(toMonacoRange),
        wordPattern,
      };
    },
  });

  monaco.languages.registerCodeLensProvider(MONACO_LANGS, {
    onDidChange: (listener) => {
      const refresh = () => listener(undefined as never);
      codeLensListeners.add(refresh);
      return { dispose: () => codeLensListeners.delete(refresh) };
    },
    async provideCodeLenses(model, token) {
      const response = await requestForModel<LspCodeLens[]>(
        model,
        "codeLensProvider",
        "textDocument/codeLens",
        {},
        token,
      );
      const options = capability(model, "codeLensProvider")?.value;
      const lenses = (response?.result ?? []).map((raw) => {
        const lens: monaco.languages.CodeLens = {
          range: toMonacoRange(raw.range),
          command: response ? toCommand(response.serverId, raw.command) : undefined,
        };
        if (response) {
          codeLensResolveLinks.set(lens, {
            serverId: response.serverId,
            raw,
            resolveProvider:
              typeof options === "object" && Boolean(options.resolveProvider),
          });
        }
        return lens;
      });
      return { lenses, dispose() {} };
    },
    async resolveCodeLens(_model, lens, token) {
      const source = codeLensResolveLinks.get(lens);
      if (!source) return lens;
      if (!source.resolveProvider) return lens;
      const resolved = (await requestLsp<LspCodeLens>(
        source.serverId,
        "codeLens/resolve",
        source.raw,
        token,
      )
        .catch(() => null)) as LspCodeLens | null;
      if (resolved) lens.command = toCommand(source.serverId, resolved.command);
      return lens;
    },
  });

  monaco.languages.registerColorProvider(MONACO_LANGS, {
    async provideDocumentColors(model, token) {
      const response = await requestForModel<ColorInformation[]>(
        model,
        "colorProvider",
        "textDocument/documentColor",
        {},
        token,
      );
      return (response?.result ?? []).map((info) => ({
        range: toMonacoRange(info.range),
        color: info.color,
      }));
    },
    async provideColorPresentations(model, colorInfo, token) {
      const response = await requestForModel<ColorPresentation[]>(
        model,
        "colorProvider",
        "textDocument/colorPresentation",
        { range: lspRange(colorInfo.range), color: colorInfo.color },
        token,
      );
      return (response?.result ?? []).map((presentation) => ({
        label: presentation.label,
        textEdit: presentation.textEdit
          ? {
              range: toMonacoRange(presentation.textEdit.range),
              text: presentation.textEdit.newText,
            }
          : undefined,
        additionalTextEdits: toTextEdits(presentation.additionalTextEdits ?? null),
      }));
    },
  });

  const convertInlayHint = (
    serverId: string,
    raw: LspInlayHint,
    resolveProvider = false,
  ): monaco.languages.InlayHint => {
    const hint: monaco.languages.InlayHint = {
      position: {
        lineNumber: raw.position.line + 1,
        column: raw.position.character + 1,
      },
      label:
        typeof raw.label === "string"
          ? raw.label
          : raw.label.map((part) => ({
              label: part.value,
              tooltip: part.tooltip
                ? { value: markupValue(part.tooltip) }
                : undefined,
              command: toCommand(serverId, part.command),
              location: part.location
                ? {
                    uri: monaco.Uri.parse(part.location.uri),
                    range: toMonacoRange(part.location.range),
                  }
                : undefined,
            })),
      kind: raw.kind as monaco.languages.InlayHintKind | undefined,
      tooltip: raw.tooltip ? { value: markupValue(raw.tooltip) } : undefined,
      textEdits: toTextEdits(raw.textEdits ?? null),
      paddingLeft: raw.paddingLeft,
      paddingRight: raw.paddingRight,
    };
    inlayResolveLinks.set(hint, { serverId, raw, resolveProvider });
    return hint;
  };
  monaco.languages.registerInlayHintsProvider(MONACO_LANGS, {
    onDidChangeInlayHints: (listener) => {
      inlayHintListeners.add(listener);
      return { dispose: () => inlayHintListeners.delete(listener) };
    },
    async provideInlayHints(model, range, token) {
      const response = await requestForModel<LspInlayHint[]>(
        model,
        "inlayHintProvider",
        "textDocument/inlayHint",
        { range: lspRange(range) },
        token,
      );
      const options = capability(model, "inlayHintProvider")?.value;
      const resolveProvider =
        typeof options === "object" && Boolean(options.resolveProvider);
      return {
        hints: response
          ? response.result.map((hint) =>
              convertInlayHint(response.serverId, hint, resolveProvider),
            )
          : [],
        dispose() {},
      };
    },
    async resolveInlayHint(hint, token) {
      const source = inlayResolveLinks.get(hint);
      if (!source) return hint;
      if (!source.resolveProvider) return hint;
      const resolved = (await requestLsp<LspInlayHint>(
        source.serverId,
        "inlayHint/resolve",
        source.raw,
        token,
      )
        .catch(() => null)) as LspInlayHint | null;
      return resolved
        ? convertInlayHint(source.serverId, resolved, source.resolveProvider)
        : hint;
    },
  });

  monaco.languages.registerInlineCompletionsProvider(MONACO_LANGS, {
    onDidChangeInlineCompletions: (listener) => {
      inlineCompletionListeners.add(listener);
      return { dispose: () => inlineCompletionListeners.delete(listener) };
    },
    async provideInlineCompletions(model, position, context, token) {
      const response = await requestForModel<
        | Array<{
            insertText: string | { kind: "snippet"; value: string };
            filterText?: string;
            range?: LspRange;
            command?: LspCommand;
          }>
        | {
            items: Array<{
              insertText: string | { kind: "snippet"; value: string };
              filterText?: string;
              range?: LspRange;
              command?: LspCommand;
            }>;
          }
      >(
        model,
        "inlineCompletionProvider",
        "textDocument/inlineCompletion",
        {
          position: lspPos(position),
          context: {
            triggerKind:
              context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
                ? 1
                : 2,
            selectedCompletionInfo: context.selectedSuggestionInfo
              ? {
                  range: lspRange(context.selectedSuggestionInfo.range),
                  text: context.selectedSuggestionInfo.text,
                }
              : undefined,
          },
        },
        token,
      );
      const rawItems = Array.isArray(response?.result)
        ? response.result
        : (response?.result.items ?? []);
      return {
        items: rawItems.map((item) => ({
          insertText:
            typeof item.insertText === "string"
              ? item.insertText
              : { snippet: item.insertText.value },
          range: item.range ? toMonacoRange(item.range) : undefined,
          command: response ? toCommand(response.serverId, item.command) : undefined,
        })),
      };
    },
    disposeInlineCompletions() {},
  });

  for (const language of MONACO_LANGS) {
    const semanticOptions = () => {
      const serverId = serverIdForLanguage(language);
      const model = monaco.editor
        .getModels()
        .find((candidate) => candidate.getLanguageId() === language);
      const value = model
        ? capability(model, "semanticTokensProvider")?.value
        : serverId
          ? serverCapability(serverId, "semanticTokensProvider")
          : undefined;
      return value && typeof value === "object" ? value : undefined;
    };
    monaco.languages.registerDocumentSemanticTokensProvider(language, {
      onDidChange: (listener) => {
        const listeners = semanticTokenListeners.get(language) ?? new Set();
        listeners.add(listener);
        semanticTokenListeners.set(language, listeners);
        return { dispose: () => listeners.delete(listener) };
      },
      getLegend: () => semanticOptions()?.legend ?? { tokenTypes: [], tokenModifiers: [] },
      async provideDocumentSemanticTokens(model, lastResultId, token) {
        const supported = capability(model, "semanticTokensProvider");
        const options =
          supported && typeof supported.value === "object"
            ? supported.value
            : undefined;
        if (!supported || !options?.full) return null;
        const delta =
          lastResultId && typeof options.full === "object" && options.full.delta;
        const method = delta
          ? "textDocument/semanticTokens/full/delta"
          : "textDocument/semanticTokens/full";
        let result = (await requestLsp<SemanticTokens | SemanticTokensDelta>(
          supported.serverId,
          method,
          {
            textDocument: { uri: model.uri.toString() },
            previousResultId: delta ? lastResultId : undefined,
          },
          token,
        )
          .catch(() => null)) as SemanticTokens | SemanticTokensDelta | null;
        if (!result && delta) {
          result = (await requestLsp<SemanticTokens>(
            supported.serverId,
            "textDocument/semanticTokens/full",
            {
              textDocument: { uri: model.uri.toString() },
            },
            token,
          )
            .catch(() => null)) as SemanticTokens | null;
        }
        if (!result) return null;
        if ("edits" in result) {
          return {
            resultId: result.resultId,
            edits: result.edits.map((edit) => ({
              start: edit.start,
              deleteCount: edit.deleteCount,
              data: edit.data ? new Uint32Array(edit.data) : undefined,
            })),
          };
        }
        return { resultId: result.resultId, data: new Uint32Array(result.data) };
      },
      releaseDocumentSemanticTokens() {},
    });
    monaco.languages.registerDocumentRangeSemanticTokensProvider(language, {
      onDidChange: (listener) => {
        const listeners = semanticTokenListeners.get(language) ?? new Set();
        listeners.add(listener);
        semanticTokenListeners.set(language, listeners);
        return { dispose: () => listeners.delete(listener) };
      },
      getLegend: () => semanticOptions()?.legend ?? { tokenTypes: [], tokenModifiers: [] },
      async provideDocumentRangeSemanticTokens(model, range, token) {
        const supported = capability(model, "semanticTokensProvider");
        const options =
          supported && typeof supported.value === "object"
            ? supported.value
            : undefined;
        if (!supported || !options?.range) return null;
        const result = (await requestLsp<SemanticTokens>(
          supported.serverId,
          "textDocument/semanticTokens/range",
          {
            textDocument: { uri: model.uri.toString() },
            range: lspRange(range),
          },
          token,
        )
          .catch(() => null)) as SemanticTokens | null;
        return result
          ? { resultId: result.resultId, data: new Uint32Array(result.data) }
          : null;
      },
    });
  }

  window.logos.lsp.onRequest(async ({ serverId, method, params, signal }) => {
    if (method === "workspace/configuration") {
      const items = (params as { items?: Array<{ scopeUri?: string; section?: string }> })
        .items ?? [];
      return resolveLspConfiguration(useStore.getState().settings, items);
    }
    if (method === "client/registerCapability") {
      const registrations = (params as { registrations?: LspRegistration[] })
        .registrations ?? [];
      const supportedMethods = new Set([
        ...Object.values(CAPABILITY_METHOD),
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didClose",
        "textDocument/didSave",
        "textDocument/willSave",
        "textDocument/willSaveWaitUntil",
        "workspace/didChangeWatchedFiles",
        "workspace/didCreateFiles",
        "workspace/willCreateFiles",
        "workspace/didRenameFiles",
        "workspace/willRenameFiles",
        "workspace/didDeleteFiles",
        "workspace/willDeleteFiles",
      ]);
      const map = dynamicRegistrations.get(serverId) ?? new Map();
      for (const registration of registrations) {
        if (!supportedMethods.has(registration.method)) {
          throw new Error(
            `No LSP client implementation for ${registration.method}`,
          );
        }
        const existing = map.get(registration.id);
        if (
          existing &&
          (existing.method !== registration.method ||
            JSON.stringify(existing.registerOptions) !==
              JSON.stringify(registration.registerOptions))
        ) {
          throw new Error(`Duplicate LSP registration id: ${registration.id}`);
        }
      }
      for (const registration of registrations) {
        map.set(registration.id, registration);
        const key = Object.entries(CAPABILITY_METHOD).find(
          ([, registeredMethod]) => registeredMethod === registration.method,
        )?.[0] as keyof ServerCapabilities | undefined;
        if (key) disabledStaticCapabilities.get(serverId)?.delete(key);
      }
      dynamicRegistrations.set(serverId, map);
      if (registrations.some((item) => item.method === "textDocument/didOpen")) {
        for (const model of monaco.editor.getModels()) {
          if (serverIdForLanguage(model.getLanguageId()) !== serverId) continue;
          const registration = registrations.find(
            (item) =>
              item.method === "textDocument/didOpen" &&
              matchesLspDocumentSelector(
                item.registerOptions,
                lspLanguageId(model.getLanguageId(), model.uri.fsPath),
                { scheme: model.uri.scheme, path: model.uri.path },
              ),
          );
          if (
            !registration ||
            sentDidOpen.has(diagnosticKey(serverId, model.uri.fsPath))
          ) continue;
          openDocs.set(model.uri.fsPath, serverId);
          const key = diagnosticKey(serverId, model.uri.fsPath);
          sentDidOpen.add(key);
          void window.logos.lsp
            .request(serverId, "textDocument/didOpen", {
              textDocument: {
                uri: model.uri.toString(),
                languageId: lspLanguageId(
                  model.getLanguageId(),
                  model.uri.fsPath,
                ),
                version: model.getVersionId(),
                text: model.getValue(),
              },
            })
            .catch(() => sentDidOpen.delete(key));
        }
      }
      fireProviderRefresh(serverId);
      for (const model of monaco.editor.getModels()) {
        if (serverIdForLanguage(model.getLanguageId()) === serverId) {
          scheduleDocumentDiagnostics(model, 0);
        }
      }
      return null;
    }
    if (method === "client/unregisterCapability") {
      const unregistrations = (
        params as {
          unregisterations?: Array<{ id: string; method?: string }>;
          unregistrations?: Array<{ id: string; method?: string }>;
        }
      ).unregisterations ??
        (params as {
          unregistrations?: Array<{ id: string; method?: string }>;
        }).unregistrations ??
        [];
      const map = dynamicRegistrations.get(serverId);
      for (const registration of unregistrations) {
        map?.delete(registration.id);
        if (!registration.method) continue;
        const key = Object.entries(CAPABILITY_METHOD).find(
          ([, registeredMethod]) => registeredMethod === registration.method,
        )?.[0] as keyof ServerCapabilities | undefined;
        const staticValue = key
          ? serverCapabilities.get(serverId)?.[key]
          : undefined;
        if (
          key &&
          typeof staticValue === "object" &&
          "id" in staticValue &&
          staticValue.id === registration.id
        ) {
          const disabled = disabledStaticCapabilities.get(serverId) ?? new Set();
          disabled.add(key);
          disabledStaticCapabilities.set(serverId, disabled);
        }
      }
      fireProviderRefresh(serverId);
      if (
        unregistrations.some(
          (registration) => registration.method === "textDocument/diagnostic",
        )
      ) {
        for (const model of monaco.editor.getModels()) {
          if (
            serverIdForLanguage(model.getLanguageId()) === serverId &&
            !capability(model, "diagnosticProvider")
          ) {
            publishDiagnostics(serverId, model.uri.toString(), []);
          }
        }
      }
      return null;
    }
    if (method === "window/workDoneProgress/create") {
      const token = (params as { token: string | number }).token;
      const tokens = workDoneTokens.get(serverId) ?? new Set();
      tokens.add(token);
      workDoneTokens.set(serverId, tokens);
      return null;
    }
    if (method === "window/showMessageRequest") {
      const request = params as {
        type?: number;
        message?: string;
        actions?: Array<{ title: string; [key: string]: unknown }>;
      };
      return new Promise((resolve) => {
        window.dispatchEvent(
          new CustomEvent("logos:lsp-message-request", {
            detail: {
              type: request.type,
              message: request.message ?? "",
              actions: request.actions ?? [],
              signal,
              resolve,
            },
          }),
        );
      });
    }
    if (method === "window/showDocument") {
      const request = params as {
        uri?: string;
        external?: boolean;
        takeFocus?: boolean;
        selection?: LspRange;
      };
      if (!request.uri) return { success: false };
      try {
        if (request.external) {
          await window.logos.app.openExternal(request.uri);
        } else {
          const uri = monaco.Uri.parse(request.uri);
          if (uri.scheme !== "file") {
            await window.logos.app.openExternal(request.uri);
          } else {
            if (!(await window.logos.fs.exists(uri.fsPath))) {
              return { success: false };
            }
            if (request.selection) {
              const target = toMonacoRange(request.selection);
              pendingNavigation.set(uri.fsPath, target);
              window.dispatchEvent(
                new CustomEvent("logos:lsp-navigate", {
                  detail: {
                    path: uri.fsPath,
                    target,
                    takeFocus: request.takeFocus,
                  },
                }),
              );
            }
            const previousTab = useStore.getState().activeTabId;
            useStore.getState().openFile(uri.fsPath);
            if (request.takeFocus === false && previousTab) {
              useStore.getState().setActiveTab(previousTab);
            }
          }
        }
        return { success: true };
      } catch {
        return { success: false };
      }
    }
    if (method === "workspace/applyEdit") {
      const edit = (params as { edit?: LspWorkspaceEdit }).edit;
      if (!edit) return { applied: false, failureReason: "Missing workspace edit" };
      try {
        await applyWorkspaceEdit(edit, signal);
        return { applied: true };
      } catch (error) {
        return {
          applied: false,
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (method === "workspace/semanticTokens/refresh") {
      fireSemanticTokensChanged(serverId);
      return null;
    }
    if (method === "workspace/inlayHint/refresh") {
      for (const listener of inlayHintListeners) listener();
      return null;
    }
    if (method === "workspace/codeLens/refresh") {
      for (const listener of codeLensListeners) listener();
      return null;
    }
    if (method === "workspace/diagnostic/refresh") {
      for (const model of monaco.editor.getModels()) {
        if (serverIdForLanguage(model.getLanguageId()) === serverId) {
          diagnosticResultIds.delete(diagnosticKey(serverId, model.uri.toString()));
          scheduleDocumentDiagnostics(model, 0);
        }
      }
      void pullWorkspaceDiagnostics(serverId);
      return null;
    }
    throw new Error(`Unsupported LSP client request: ${method}`);
  });

  window.logos.lsp.onNotify(({ serverId, method, params }) => {
    if (method === "textDocument/publishDiagnostics") {
      const diagnostics = params as {
        uri: string;
        version?: number;
        diagnostics: LspDiagnostic[];
      };
      publishDiagnostics(
        serverId,
        diagnostics.uri,
        diagnostics.diagnostics,
        diagnostics.version,
      );
      return;
    }
    if (method === "window/showMessage") {
      const message = params as { type?: number; message?: string };
      if (!message.message) return;
      if (message.type === 1) notifyError(message.message);
      else if (message.type === 3 || message.type === 4) notifyInfo(message.message);
      else notify(message.message);
      return;
    }
    if (method === "$/progress") {
      const progress = params as {
        token: string | number;
        value?: {
          kind?: "begin" | "report" | "end";
          title?: string;
          message?: string;
          percentage?: number;
          cancellable?: boolean;
        };
      };
      const partialHandler = partialResultHandlers.get(
        `${serverId}:${String(progress.token)}`,
      );
      if (partialHandler) {
        partialHandler(progress.value);
        return;
      }
      if (!workDoneTokens.get(serverId)?.has(progress.token) || !progress.value) return;
      const currentKey = `${serverId}:${typeof progress.token}:${progress.token}`;
      const current = useStore.getState().lspWorkDone[currentKey];
      if (progress.value.kind === "end") {
        workDoneTokens.get(serverId)?.delete(progress.token);
        useStore.getState().clearLspWorkDone(serverId, progress.token);
      } else {
        const percentage = Math.max(
          current?.percentage ?? 0,
          Math.min(100, Math.max(0, progress.value.percentage ?? 0)),
        );
        useStore.getState().setLspWorkDone({
          serverId,
          token: progress.token,
          title: progress.value.title ?? current?.title ?? "Language server",
          message: progress.value.message ?? current?.message,
          percentage:
            progress.value.percentage == null && current?.percentage == null
              ? undefined
              : percentage,
          cancellable: progress.value.cancellable ?? current?.cancellable ?? false,
        });
      }
    }
  });

  // A1 self-heal + C2 readiness surfacing. (The store `lsp` slice is written by
  // a separate subscriber in `bootstrap()`; this one owns Monaco-side state.)
  window.logos.lsp.onProgress((p) => {
    if (p.status === "stopped" || p.status === "error") {
      // Drop the crashed/failed server and forget the docs opened against it so
      // the next edit re-attempts and reopenModelsFor re-sends didOpen.
      startedServers.delete(p.id);
      serverCapabilities.delete(p.id);
      dynamicRegistrations.delete(p.id);
      disabledStaticCapabilities.delete(p.id);
      for (const token of workDoneTokens.get(p.id) ?? []) {
        useStore.getState().clearLspWorkDone(p.id, token);
      }
      workDoneTokens.delete(p.id);
      for (const key of diagnosticResultIds.keys()) {
        if (key.startsWith(`${p.id}\u0000`)) diagnosticResultIds.delete(key);
      }
      for (const key of diagnosticRequestGenerations.keys()) {
        if (key.startsWith(`${p.id}\u0000`)) {
          diagnosticRequestGenerations.delete(key);
        }
      }
      for (const [key, controller] of diagnosticControllers) {
        if (!key.startsWith(`${p.id}\u0000`)) continue;
        controller.abort();
        diagnosticControllers.delete(key);
      }
      workspaceDiagnosticGenerations.delete(p.id);
      const workspaceTimer = workspaceDiagnosticTimers.get(p.id);
      if (workspaceTimer) clearTimeout(workspaceTimer);
      workspaceDiagnosticTimers.delete(p.id);
      workspaceDiagnosticControllers.get(p.id)?.abort();
      workspaceDiagnosticControllers.delete(p.id);
      for (const key of partialResultHandlers.keys()) {
        if (key.startsWith(`${p.id}:`)) partialResultHandlers.delete(key);
      }
      fireSemanticTokensChanged(p.id);
      for (const model of monaco.editor.getModels()) {
        if (serverIdForLanguage(model.getLanguageId()) === p.id) {
          openDocs.delete(model.uri.fsPath);
          sentDidOpen.delete(diagnosticKey(p.id, model.uri.fsPath));
          publishedDiagnostics.delete(model.uri.toString());
          monaco.editor.setModelMarkers(model, "logos-lsp", []);
          useStore.getState().setDiagnostics(model.uri.fsPath, []);
        }
      }
      for (const [uriString, owner] of diagnosticOwners) {
        if (owner !== p.id) continue;
        const uri = monaco.Uri.parse(uriString);
        const model = monaco.editor.getModel(uri);
        if (model) monaco.editor.setModelMarkers(model, "logos-lsp", []);
        useStore.getState().setDiagnostics(uri.fsPath, []);
        diagnosticOwners.delete(uriString);
        publishedDiagnostics.delete(uriString);
      }
    } else if (p.status === "running") {
      if (!serverCapabilities.has(p.id)) return;
      startedServers.add(p.id);
      reopenModelsFor(p.id);
      // C2: a cold server just came up — re-trigger suggest on the focused
      // editor so members appear without deleting/retyping.
      window.dispatchEvent(
        new CustomEvent("logos:lsp-ready", { detail: { serverId: p.id } }),
      );
    }
  });

  window.logos.fs.onWatchEvent((event) => {
    void (async () => {
      const exists = await window.logos.fs.exists(event.path).catch(() => false);
      const type = event.type === "change" ? 2 : exists ? 1 : 3;
      const watchKind = type === 3 ? 4 : type;
      for (const serverId of startedServers) {
        const watches = [
          ...(dynamicRegistrations.get(serverId)?.values() ?? []),
        ].some((registration) => {
          if (registration.method !== "workspace/didChangeWatchedFiles") {
            return false;
          }
          const watchers = registration.registerOptions?.watchers;
          if (!Array.isArray(watchers)) return false;
          return watchers.some((raw) => {
            const watcher = raw as {
              globPattern:
                | string
                | {
                    baseUri: string | { uri: string };
                    pattern: string;
                  };
              kind?: number;
            };
            if (((watcher.kind ?? 7) & watchKind) === 0) return false;
            if (typeof watcher.globPattern === "string") {
              const root = useStore.getState().root?.replaceAll("\\", "/");
              const eventPath = event.path.replaceAll("\\", "/");
              const relative =
                root && (eventPath === root || eventPath.startsWith(`${root}/`))
                  ? eventPath.slice(root.length).replace(/^\//, "")
                  : eventPath;
              return (
                matchesLspGlob(watcher.globPattern, relative) ||
                matchesLspGlob(watcher.globPattern, eventPath)
              );
            }
            const baseUri =
              typeof watcher.globPattern.baseUri === "string"
                ? watcher.globPattern.baseUri
                : watcher.globPattern.baseUri.uri;
            const basePath = monaco.Uri.parse(baseUri).fsPath.replaceAll("\\", "/");
            const eventPath = event.path.replaceAll("\\", "/");
            if (eventPath !== basePath && !eventPath.startsWith(`${basePath}/`)) {
              return false;
            }
            const relative = eventPath.slice(basePath.length).replace(/^\//, "");
            return matchesLspGlob(watcher.globPattern.pattern, relative);
          });
        });
        if (!watches) continue;
        void window.logos.lsp.request(
          serverId,
          "workspace/didChangeWatchedFiles",
          { changes: [{ uri: uriOf(event.path), type }] },
        );
      }
    })();
  });

  // A language server is rooted to one workspace. Tear it down before opening
  // models against a different root so navigation never uses a stale project.
  useStore.subscribe((state, prev) => {
    if (state.settings !== prev.settings) {
      const settings = resolveLspConfiguration(state.settings, [{}])[0];
      for (const serverId of startedServers) {
        void window.logos.lsp.request(
          serverId,
          "workspace/didChangeConfiguration",
          { settings },
        );
      }
    }
    if (state.root === prev.root) return;
    const generation = ++rootChangeGeneration;
    if (prev.root) void window.logos.fs.unwatch(prev.root);
    if (state.root) void window.logos.fs.watch(state.root);
    const pendingStarts = [...inflight.values()];
    void Promise.allSettled(pendingStarts).then(async () => {
      if (generation !== rootChangeGeneration) return;
      const listed = await window.logos.lsp.list().catch(() => []);
      if (generation !== rootChangeGeneration) return;
      const servers = [
        ...new Set([
          ...startedServers,
          ...listed
            .filter((server) => server.status === "running")
            .map((server) => server.id),
        ]),
      ];
      startedServers.clear();
      serverCapabilities.clear();
      dynamicRegistrations.clear();
      disabledStaticCapabilities.clear();
      diagnosticResultIds.clear();
      diagnosticRequestGenerations.clear();
      for (const controller of diagnosticControllers.values()) controller.abort();
      diagnosticControllers.clear();
      workspaceDiagnosticGenerations.clear();
      for (const timer of workspaceDiagnosticTimers.values()) clearTimeout(timer);
      workspaceDiagnosticTimers.clear();
      for (const controller of workspaceDiagnosticControllers.values()) {
        controller.abort();
      }
      workspaceDiagnosticControllers.clear();
      for (const timer of diagnosticTimers.values()) clearTimeout(timer);
      diagnosticTimers.clear();
      for (const [serverId, tokens] of workDoneTokens) {
        for (const token of tokens) {
          useStore.getState().clearLspWorkDone(serverId, token);
        }
      }
      workDoneTokens.clear();
      partialResultHandlers.clear();
      for (const serverId of servers) fireSemanticTokensChanged(serverId);
      openDocs.clear();
      sentDidOpen.clear();
      openingDocs.clear();
      publishedDiagnostics.clear();
      diagnosticOwners.clear();
      for (const model of monaco.editor.getModels()) {
        monaco.editor.setModelMarkers(model, "logos-lsp", []);
      }
      useStore.setState({ diagnostics: {} });
      await Promise.all(servers.map((id) => window.logos.lsp.stop(id)));
      if (generation !== rootChangeGeneration) return;
      if (useStore.getState().root) ensureServersForOpenModels();
    });
  });
}

function severityToMonaco(sev: number): monaco.MarkerSeverity {
  switch (sev) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}
