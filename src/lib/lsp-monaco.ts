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
import { applyLspTextEdits, isSafeWordPattern } from "./lsp-utils";

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
const publishedDiagnostics = new Map<string, LspDiagnostic[]>();
const semanticTokenListeners = new Map<
  string,
  Set<(event: void) => unknown>
>();

function fireSemanticTokensChanged(serverId: string) {
  for (const language of MONACO_LANGS) {
    if (serverIdForLanguage(language) !== serverId) continue;
    for (const listener of semanticTokenListeners.get(language) ?? []) {
      listener();
    }
  }
}

function uriOf(path: string): string {
  return monaco.Uri.file(path).toString();
}

function syncOptions(serverId: string) {
  return serverCapabilities.get(serverId)?.textDocumentSync;
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
    const capabilities = await window.logos.lsp.start(serverId, root);
    if (useStore.getState().root !== root) {
      await window.logos.lsp.stop(serverId);
      return null;
    }
    serverCapabilities.set(serverId, capabilities);
    startedServers.add(serverId);
    fireSemanticTokensChanged(serverId);
    window.dispatchEvent(
      new CustomEvent("logos:lsp-ready", { detail: { serverId } }),
    );
    return serverId;
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

export function lspOpenDoc(path: string, monacoLang: string, content: string) {
  void (async () => {
    const serverId = await ensureServer(monacoLang);
    if (!serverId) return;
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    if (openDocs.has(path)) return; // already opened (e.g. by reopenModelsFor)
    openDocs.set(path, serverId);
    const sync = syncOptions(serverId);
    if (typeof sync === "object" && sync.openClose !== true) return;
    await window.logos.lsp.request(serverId, "textDocument/didOpen", {
      textDocument: {
        uri: uriOf(path),
        languageId: lspLanguageId(monacoLang, path),
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
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
  const sync = syncOptions(serverId);
  const changeKind = typeof sync === "number" ? sync : (sync?.change ?? 0);
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
}

export function lspCloseDoc(path: string) {
  const serverId = openDocs.get(path);
  if (!serverId) return;
  openDocs.delete(path);
  publishedDiagnostics.delete(uriOf(path));
  const sync = syncOptions(serverId);
  if (typeof sync !== "object" || sync.openClose === true) {
    void window.logos.lsp.request(serverId, "textDocument/didClose", {
      textDocument: { uri: uriOf(path) },
    });
  }
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (model) monaco.editor.setModelMarkers(model, "logos-lsp", []);
  useStore.getState().setDiagnostics(path, []);
}

/** Notify the server that a document was saved (enables save-time linting). */
export function lspSaveDoc(path: string, monacoLang: string, content: string) {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId || !startedServers.has(serverId) || openDocs.get(path) !== serverId)
    return;
  const sync = syncOptions(serverId);
  const save = typeof sync === "object" ? sync.save : false;
  if (!save) return;
  void window.logos.lsp.request(serverId, "textDocument/didSave", {
    textDocument: { uri: uriOf(path) },
    text: typeof save === "object" && save.includeText ? content : undefined,
  });
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
    if (typeof sync === "object" && sync.openClose !== true) continue;
    void window.logos.lsp.request(serverId, "textDocument/didOpen", {
      textDocument: {
        uri: model.uri.toString(),
        languageId: lspLanguageId(lang, path),
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
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
  { serverId: string; raw: Record<string, unknown> }
>();

function capability<K extends keyof ServerCapabilities>(
  model: monaco.editor.ITextModel,
  key: K,
): { serverId: string; value: NonNullable<ServerCapabilities[K]> } | null {
  const serverId = serverIdForLanguage(model.getLanguageId());
  if (!serverId || !startedServers.has(serverId)) return null;
  const value = serverCapabilities.get(serverId)?.[key];
  if (!value) return null;
  return { serverId, value: value as NonNullable<ServerCapabilities[K]> };
}

async function requestForModel<T>(
  model: monaco.editor.ITextModel,
  capabilityKey: keyof ServerCapabilities,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ serverId: string; result: T } | null> {
  const supported = capability(model, capabilityKey);
  if (!supported) return null;
  const result = (await window.logos.lsp
    .request(supported.serverId, method, {
      textDocument: { uri: model.uri.toString() },
      ...params,
    })
    .catch(() => null)) as T | null;
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
  const wasOpen = useStore.getState().tabs.some((tab) => tab.id === tabId);
  if (model) {
    await window.logos.fs.writeFile(uri.fsPath, model.getValue());
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

async function applyWorkspaceEdit(edit: LspWorkspaceEdit): Promise<void> {
  for (const [uri, changes] of Object.entries(edit.changes ?? {})) {
    await applyTextDocumentEdit(uri, changes);
  }
  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) {
      await applyTextDocumentEdit(
        change.textDocument.uri,
        protocolTextEdits(change.edits),
        change.textDocument.version,
      );
      continue;
    }
    if (change.kind === "create") {
      const uri = monaco.Uri.parse(change.uri);
      if (uri.scheme !== "file")
        throw new Error(`Cannot create URI: ${uri.toString()}`);
      const exists = await window.logos.fs.exists(uri.fsPath);
      if (exists && !change.options?.overwrite) {
        if (change.options?.ignoreIfExists) continue;
        throw new Error(`File already exists: ${uri.fsPath}`);
      }
      const model = monaco.editor.getModel(uri);
      if (model) model.setValue("");
      await window.logos.fs.writeFile(uri.fsPath, "");
      continue;
    }
    if (change.kind === "rename") {
      const oldUri = monaco.Uri.parse(change.oldUri);
      const newUri = monaco.Uri.parse(change.newUri);
      if (oldUri.scheme !== "file" || newUri.scheme !== "file")
        throw new Error(`Cannot rename non-file URI: ${change.oldUri}`);
      const targetExists = await window.logos.fs.exists(newUri.fsPath);
      if (targetExists && !change.options?.overwrite) {
        if (change.options?.ignoreIfExists) continue;
        throw new Error(`Rename target already exists: ${newUri.fsPath}`);
      }
      const reopened = await closeEditedResourceTree(oldUri);
      if (targetExists) {
        await closeEditedResourceTree(newUri);
        await window.logos.fs.delete(newUri.fsPath);
      }
      await window.logos.fs.rename(oldUri.fsPath, newUri.fsPath);
      for (const suffix of reopened) {
        useStore.getState().openFile(`${newUri.fsPath}${suffix}`);
      }
      continue;
    }
    if (change.kind === "delete") {
      const uri = monaco.Uri.parse(change.uri);
      if (uri.scheme !== "file")
        throw new Error(`Cannot delete URI: ${uri.toString()}`);
      const exists = await window.logos.fs.exists(uri.fsPath);
      if (!exists) {
        if (change.options?.ignoreIfNotExists) continue;
        throw new Error(`File does not exist: ${uri.fsPath}`);
      }
      const stat = await window.logos.fs.stat(uri.fsPath);
      if (stat.type === "directory" && !change.options?.recursive) {
        const listing = await window.logos.fs.readDir(uri.fsPath);
        if (listing.entries.length)
          throw new Error(`Recursive delete was not requested: ${uri.fsPath}`);
      }
      await closeEditedResourceTree(uri);
      await window.logos.fs.delete(uri.fsPath);
    }
  }
}

const pendingNavigation = new Map<string, monaco.IRange | monaco.IPosition>();

export function takeLspNavigationTarget(
  path: string,
): monaco.IRange | monaco.IPosition | undefined {
  const target = pendingNavigation.get(path);
  pendingNavigation.delete(path);
  return target;
}

const linkResolveLinks = new WeakMap<
  monaco.languages.ILink,
  { serverId: string; raw: DocumentLink }
>();
const codeLensResolveLinks = new WeakMap<
  monaco.languages.CodeLens,
  { serverId: string; raw: LspCodeLens }
>();
const inlayResolveLinks = new WeakMap<
  monaco.languages.InlayHint,
  { serverId: string; raw: LspInlayHint }
>();

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
    async (_accessor, serverId: string, action: LspCodeAction) => {
      let resolved = action;
      const options = serverCapabilities.get(serverId)?.codeActionProvider;
      if (typeof options === "object" && options.resolveProvider && action.data) {
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
      });
    }
  }

  monaco.languages.registerCompletionItemProvider(MONACO_LANGS, {
    triggerCharacters: [
      ".", '"', "'", "/", "@", "<", ":", " ", "#", "=", "(", ",", ">", "*", "&",
    ],
    async provideCompletionItems(model, position, context) {
      const supported = capability(model, "completionProvider");
      if (!supported) return { suggestions: [] };
      const { serverId } = supported;
      const triggerCharacter = context.triggerCharacter;
      const validTrigger =
        context.triggerKind !==
          monaco.languages.CompletionTriggerKind.TriggerCharacter ||
        (triggerCharacter != null &&
          supported.value.triggerCharacters?.includes(triggerCharacter));
      const res = (await window.logos.lsp
        .request(serverId, "textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: lspPos(position),
          // C2: forward the trigger context so servers distinguish `.`-style
          // member completion from a plain invocation.
          context: {
            triggerKind: validTrigger ? lspTriggerKind(context.triggerKind) : 1,
            triggerCharacter: validTrigger ? triggerCharacter : undefined,
          },
        })
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
        resolveLinks.set(item, { serverId, raw: it });
        return item;
      });
      return { suggestions, incomplete };
    },
    async resolveCompletionItem(item) {
      const link = resolveLinks.get(item);
      if (!link) return item;
      if (!serverCapabilities.get(link.serverId)?.completionProvider?.resolveProvider)
        return item;
      const resolved = (await window.logos.lsp
        .request(link.serverId, "completionItem/resolve", link.raw)
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
    async provideHover(model, position) {
      const response = await requestForModel<{
        contents?: unknown;
        range?: LspRange;
      }>(model, "hoverProvider", "textDocument/hover", {
        position: lspPos(position),
      });
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
  ) =>
    toLocationLinks(
      (
        await requestForModel<unknown>(model, capabilityKey, method, {
          position: lspPos(position),
        })
      )?.result,
    );

  monaco.languages.registerDefinitionProvider(MONACO_LANGS, {
    provideDefinition: (model, position) =>
      navigation(model, position, "definitionProvider", "textDocument/definition"),
  });
  monaco.languages.registerDeclarationProvider(MONACO_LANGS, {
    provideDeclaration: (model, position) =>
      navigation(model, position, "declarationProvider", "textDocument/declaration"),
  });
  monaco.languages.registerTypeDefinitionProvider(MONACO_LANGS, {
    provideTypeDefinition: (model, position) =>
      navigation(
        model,
        position,
        "typeDefinitionProvider",
        "textDocument/typeDefinition",
      ),
  });
  monaco.languages.registerImplementationProvider(MONACO_LANGS, {
    provideImplementation: (model, position) =>
      navigation(
        model,
        position,
        "implementationProvider",
        "textDocument/implementation",
      ),
  });

  monaco.languages.registerReferenceProvider(MONACO_LANGS, {
    async provideReferences(model, position, context) {
      const response = await requestForModel<LspLocation[]>(
        model,
        "referencesProvider",
        "textDocument/references",
        {
          position: lspPos(position),
          context: { includeDeclaration: context.includeDeclaration },
        },
      );
      return response ? toLocations(response.result) : null;
    },
  });

  monaco.languages.registerDocumentHighlightProvider(MONACO_LANGS, {
    async provideDocumentHighlights(model, position) {
      const response = await requestForModel<
        Array<{ range: LspRange; kind?: number }>
      >(
        model,
        "documentHighlightProvider",
        "textDocument/documentHighlight",
        { position: lspPos(position) },
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
    async provideDocumentSymbols(model) {
      const response = await requestForModel<
        Array<LspDocumentSymbol | SymbolInformation>
      >(model, "documentSymbolProvider", "textDocument/documentSymbol");
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
    signatureHelpTriggerCharacters: ["(", ",", "<"],
    signatureHelpRetriggerCharacters: [",", ")"],
    async provideSignatureHelp(model, position, _token, context) {
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
          },
        },
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
    async provideDocumentFormattingEdits(model, options) {
      const response = await requestForModel<LspTextEdit[]>(
        model,
        "documentFormattingProvider",
        "textDocument/formatting",
        { options },
      );
      return toTextEdits(response?.result ?? null);
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(MONACO_LANGS, {
    async provideDocumentRangeFormattingEdits(model, range, options) {
      const response = await requestForModel<LspTextEdit[]>(
        model,
        "documentRangeFormattingProvider",
        "textDocument/rangeFormatting",
        { range: lspRange(range), options },
      );
      return toTextEdits(response?.result ?? null);
    },
  });
  monaco.languages.registerOnTypeFormattingEditProvider(MONACO_LANGS, {
    autoFormatTriggerCharacters: ["}", ";", "\n", ">"],
    async provideOnTypeFormattingEdits(model, position, ch, options) {
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
      );
      return toTextEdits(response?.result ?? null);
    },
  });

  monaco.languages.registerRenameProvider(MONACO_LANGS, {
    async resolveRenameLocation(model, position) {
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
      });
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
    async provideRenameEdits(model, position, newName) {
      const response = await requestForModel<LspWorkspaceEdit>(
        model,
        "renameProvider",
        "textDocument/rename",
        { position: lspPos(position), newName },
      );
      if (!response) return { edits: [], rejectReason: "Rename failed" };
      await applyWorkspaceEdit(response.result);
      return { edits: [] };
    },
  });

  const convertCodeAction = async (
    serverId: string,
    raw: LspCodeAction | LspCommand,
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
              arguments: [serverId, action],
            },
    };
    return converted;
  };
  monaco.languages.registerCodeActionProvider(MONACO_LANGS, {
    async provideCodeActions(model, range, context) {
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
      );
      const actions = response
        ? await Promise.all(
            response.result.map((action) =>
              convertCodeAction(response.serverId, action),
            ),
          )
        : [];
      return { actions, dispose() {} };
    },
  });

  monaco.languages.registerLinkProvider(MONACO_LANGS, {
    async provideLinks(model) {
      const response = await requestForModel<DocumentLink[]>(
        model,
        "documentLinkProvider",
        "textDocument/documentLink",
      );
      const links = (response?.result ?? []).map((raw) => {
        const link: monaco.languages.ILink = {
          range: toMonacoRange(raw.range),
          url: raw.target,
          tooltip: raw.tooltip,
        };
        if (response) linkResolveLinks.set(link, { serverId: response.serverId, raw });
        return link;
      });
      return { links };
    },
    async resolveLink(link) {
      const source = linkResolveLinks.get(link);
      if (!source) return link;
      if (!serverCapabilities.get(source.serverId)?.documentLinkProvider?.resolveProvider)
        return link;
      const resolved = (await window.logos.lsp
        .request(source.serverId, "documentLink/resolve", source.raw)
        .catch(() => null)) as DocumentLink | null;
      if (!resolved) return link;
      link.url = resolved.target;
      link.tooltip = resolved.tooltip;
      return link;
    },
  });

  monaco.languages.registerFoldingRangeProvider(MONACO_LANGS, {
    async provideFoldingRanges(model) {
      const response = await requestForModel<LspFoldingRange[]>(
        model,
        "foldingRangeProvider",
        "textDocument/foldingRange",
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
    async provideSelectionRanges(model, positions) {
      const response = await requestForModel<LspSelectionRange[]>(
        model,
        "selectionRangeProvider",
        "textDocument/selectionRange",
        { positions: positions.map(lspPos) },
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
    async provideLinkedEditingRanges(model, position) {
      const response = await requestForModel<LinkedEditingRanges>(
        model,
        "linkedEditingRangeProvider",
        "textDocument/linkedEditingRange",
        { position: lspPos(position) },
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
    async provideCodeLenses(model) {
      const response = await requestForModel<LspCodeLens[]>(
        model,
        "codeLensProvider",
        "textDocument/codeLens",
      );
      const lenses = (response?.result ?? []).map((raw) => {
        const lens: monaco.languages.CodeLens = {
          range: toMonacoRange(raw.range),
          command: response ? toCommand(response.serverId, raw.command) : undefined,
        };
        if (response) codeLensResolveLinks.set(lens, { serverId: response.serverId, raw });
        return lens;
      });
      return { lenses, dispose() {} };
    },
    async resolveCodeLens(_model, lens) {
      const source = codeLensResolveLinks.get(lens);
      if (!source) return lens;
      if (!serverCapabilities.get(source.serverId)?.codeLensProvider?.resolveProvider)
        return lens;
      const resolved = (await window.logos.lsp
        .request(source.serverId, "codeLens/resolve", source.raw)
        .catch(() => null)) as LspCodeLens | null;
      if (resolved) lens.command = toCommand(source.serverId, resolved.command);
      return lens;
    },
  });

  monaco.languages.registerColorProvider(MONACO_LANGS, {
    async provideDocumentColors(model) {
      const response = await requestForModel<ColorInformation[]>(
        model,
        "colorProvider",
        "textDocument/documentColor",
      );
      return (response?.result ?? []).map((info) => ({
        range: toMonacoRange(info.range),
        color: info.color,
      }));
    },
    async provideColorPresentations(model, colorInfo) {
      const response = await requestForModel<ColorPresentation[]>(
        model,
        "colorProvider",
        "textDocument/colorPresentation",
        { range: lspRange(colorInfo.range), color: colorInfo.color },
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
    inlayResolveLinks.set(hint, { serverId, raw });
    return hint;
  };
  monaco.languages.registerInlayHintsProvider(MONACO_LANGS, {
    async provideInlayHints(model, range) {
      const response = await requestForModel<LspInlayHint[]>(
        model,
        "inlayHintProvider",
        "textDocument/inlayHint",
        { range: lspRange(range) },
      );
      return {
        hints: response
          ? response.result.map((hint) => convertInlayHint(response.serverId, hint))
          : [],
        dispose() {},
      };
    },
    async resolveInlayHint(hint) {
      const source = inlayResolveLinks.get(hint);
      if (!source) return hint;
      const options = serverCapabilities.get(source.serverId)?.inlayHintProvider;
      if (typeof options !== "object" || !options.resolveProvider) return hint;
      const resolved = (await window.logos.lsp
        .request(source.serverId, "inlayHint/resolve", source.raw)
        .catch(() => null)) as LspInlayHint | null;
      return resolved ? convertInlayHint(source.serverId, resolved) : hint;
    },
  });

  for (const language of MONACO_LANGS) {
    const semanticOptions = () => {
      const serverId = serverIdForLanguage(language);
      const value = serverId
        ? serverCapabilities.get(serverId)?.semanticTokensProvider
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
      async provideDocumentSemanticTokens(model, lastResultId) {
        const options = semanticOptions();
        const supported = capability(model, "semanticTokensProvider");
        if (!supported || !options?.full) return null;
        const delta =
          lastResultId && typeof options.full === "object" && options.full.delta;
        const method = delta
          ? "textDocument/semanticTokens/full/delta"
          : "textDocument/semanticTokens/full";
        let result = (await window.logos.lsp
          .request(supported.serverId, method, {
            textDocument: { uri: model.uri.toString() },
            previousResultId: delta ? lastResultId : undefined,
          })
          .catch(() => null)) as SemanticTokens | SemanticTokensDelta | null;
        if (!result && delta) {
          result = (await window.logos.lsp
            .request(supported.serverId, "textDocument/semanticTokens/full", {
              textDocument: { uri: model.uri.toString() },
            })
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
      async provideDocumentRangeSemanticTokens(model, range) {
        const options = semanticOptions();
        const supported = capability(model, "semanticTokensProvider");
        if (!supported || !options?.range) return null;
        const result = (await window.logos.lsp
          .request(supported.serverId, "textDocument/semanticTokens/range", {
            textDocument: { uri: model.uri.toString() },
            range: lspRange(range),
          })
          .catch(() => null)) as SemanticTokens | null;
        return result
          ? { resultId: result.resultId, data: new Uint32Array(result.data) }
          : null;
      },
    });
  }

  window.logos.lsp.onRequest(async ({ method, params }) => {
    if (method !== "workspace/applyEdit")
      throw new Error(`Unsupported LSP client request: ${method}`);
    const edit = (params as { edit?: LspWorkspaceEdit }).edit;
    if (!edit) return { applied: false, failureReason: "Missing workspace edit" };
    try {
      await applyWorkspaceEdit(edit);
      return { applied: true };
    } catch (error) {
      return {
        applied: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Diagnostics -> Monaco markers + Problems store.
  window.logos.lsp.onNotify(({ method, params }) => {
    if (method !== "textDocument/publishDiagnostics") return;
    const p = params as {
      uri: string;
      diagnostics: LspDiagnostic[];
    };
    const uri = monaco.Uri.parse(p.uri);
    publishedDiagnostics.set(p.uri, p.diagnostics);
    const model = monaco.editor.getModel(uri);
    const markers: monaco.editor.IMarkerData[] = p.diagnostics.map((d) => ({
      message: markupValue(d.message),
      severity: severityToMonaco(d.severity ?? 1),
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      source: d.source,
      code:
        d.code == null
          ? undefined
          : d.codeDescription
            ? { value: String(d.code), target: monaco.Uri.parse(d.codeDescription.href) }
            : String(d.code),
      tags: d.tags as monaco.MarkerTag[] | undefined,
    }));
    if (model) monaco.editor.setModelMarkers(model, "logos-lsp", markers);

    const diags: Diagnostic[] = p.diagnostics.map((d) => ({
      message: markupValue(d.message),
      severity: d.severity ?? 1,
      startLine: d.range.start.line + 1,
      startCol: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endCol: d.range.end.character + 1,
      source: d.source,
    }));
    useStore.getState().setDiagnostics(uri.fsPath, diags);
  });

  // A1 self-heal + C2 readiness surfacing. (The store `lsp` slice is written by
  // a separate subscriber in `bootstrap()`; this one owns Monaco-side state.)
  window.logos.lsp.onProgress((p) => {
    if (p.status === "stopped" || p.status === "error") {
      // Drop the crashed/failed server and forget the docs opened against it so
      // the next edit re-attempts and reopenModelsFor re-sends didOpen.
      startedServers.delete(p.id);
      serverCapabilities.delete(p.id);
      fireSemanticTokensChanged(p.id);
      for (const model of monaco.editor.getModels()) {
        if (serverIdForLanguage(model.getLanguageId()) === p.id) {
          openDocs.delete(model.uri.fsPath);
          publishedDiagnostics.delete(model.uri.toString());
          monaco.editor.setModelMarkers(model, "logos-lsp", []);
          useStore.getState().setDiagnostics(model.uri.fsPath, []);
        }
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

  // A language server is rooted to one workspace. Tear it down before opening
  // models against a different root so navigation never uses a stale project.
  useStore.subscribe((state, prev) => {
    if (state.root === prev.root) return;
    const pendingStarts = [...inflight.values()];
    void Promise.allSettled(pendingStarts).then(async () => {
      const servers = [...startedServers];
      startedServers.clear();
      serverCapabilities.clear();
      for (const serverId of servers) fireSemanticTokensChanged(serverId);
      openDocs.clear();
      publishedDiagnostics.clear();
      await Promise.all(servers.map((id) => window.logos.lsp.stop(id)));
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
