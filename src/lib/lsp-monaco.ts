import * as monaco from "monaco-editor";
import { useStore, type Diagnostic } from "../state/store";
import { serverIdForLanguage } from "./language";

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
  "shell",
];

/** Monaco language id -> LSP languageId. */
function lspLanguageId(monacoLang: string): string {
  if (monacoLang === "shell") return "shellscript";
  return monacoLang;
}

const startedServers = new Set<string>();
/** Server id -> in-flight start promise (dedupes concurrent ensures). */
const inflight = new Map<string, Promise<string | null>>();
const openDocs = new Set<string>();

function uriOf(path: string): string {
  return monaco.Uri.file(path).toString();
}

async function ensureServer(monacoLang: string): Promise<string | null> {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId) return null;
  if (startedServers.has(serverId)) return serverId;

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
    await window.logos.lsp.start(serverId, root);
    startedServers.add(serverId);
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
    if (openDocs.has(path)) return; // already opened (e.g. by reopenModelsFor)
    openDocs.add(path);
    await window.logos.lsp.request(serverId, "textDocument/didOpen", {
      textDocument: {
        uri: uriOf(path),
        languageId: lspLanguageId(monacoLang),
        version: 1,
        text: content,
      },
    });
  })();
}

export function lspChangeDoc(
  path: string,
  monacoLang: string,
  content: string,
  version: number,
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
  if (!openDocs.has(path)) return;
  void window.logos.lsp.request(serverId, "textDocument/didChange", {
    textDocument: { uri: uriOf(path), version },
    contentChanges: [{ text: content }],
  });
}

export function lspCloseDoc(path: string) {
  if (!openDocs.has(path)) return;
  openDocs.delete(path);
  for (const serverId of startedServers) {
    void window.logos.lsp.request(serverId, "textDocument/didClose", {
      textDocument: { uri: uriOf(path) },
    });
  }
}

/** Notify the server that a document was saved (enables save-time linting). */
export function lspSaveDoc(path: string, monacoLang: string, content: string) {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId || !startedServers.has(serverId) || !openDocs.has(path)) return;
  void window.logos.lsp.request(serverId, "textDocument/didSave", {
    textDocument: { uri: uriOf(path) },
    text: content,
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
    openDocs.add(path);
    void window.logos.lsp.request(serverId, "textDocument/didOpen", {
      textDocument: {
        uri: model.uri.toString(),
        languageId: lspLanguageId(lang),
        version: 1,
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
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  21: monaco.languages.CompletionItemKind.Constant,
};

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function lspPos(position: monaco.Position): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
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

interface LspTextEdit {
  range?: LspRange;
  insert?: LspRange;
  replace?: LspRange;
  newText: string;
}

/** Map LSP additionalTextEdits to Monaco's edit shape. */
function toMonacoEdits(
  edits: LspTextEdit[] | undefined,
): monaco.editor.ISingleEditOperation[] | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  return edits
    .filter((e) => e.range)
    .map((e) => ({ range: toMonacoRange(e.range!), text: e.newText }));
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

let providersRegistered = false;

export function setupLspMonaco() {
  if (providersRegistered) return;
  providersRegistered = true;

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
    triggerCharacters: [".", '"', "'", "/", "@", "<", ":", " "],
    async provideCompletionItems(model, position, context) {
      const lang = model.getLanguageId();
      const serverId = serverIdForLanguage(lang);
      if (!serverId || !startedServers.has(serverId)) return { suggestions: [] };
      const res = (await window.logos.lsp
        .request(serverId, "textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: lspPos(position),
          // C2: forward the trigger context so servers distinguish `.`-style
          // member completion from a plain invocation.
          context: {
            triggerKind: lspTriggerKind(context.triggerKind),
            triggerCharacter: context.triggerCharacter,
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
        const textEdit = it.textEdit as LspTextEdit | undefined;
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
          additionalTextEdits: toMonacoEdits(
            it.additionalTextEdits as LspTextEdit[] | undefined,
          ),
          insertTextRules: isSnippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        };
        // Link for lazy completionItem/resolve, only when docs were omitted.
        if (!item.documentation) resolveLinks.set(item, { serverId, raw: it });
        return item;
      });
      return { suggestions, incomplete };
    },
    async resolveCompletionItem(item) {
      const link = resolveLinks.get(item);
      if (!link) return item;
      const resolved = (await window.logos.lsp
        .request(link.serverId, "completionItem/resolve", link.raw)
        .catch(() => null)) as Record<string, unknown> | null;
      if (!resolved) return item;
      if (resolved.detail) item.detail = String(resolved.detail);
      if (resolved.documentation)
        item.documentation = { value: markupValue(resolved.documentation) };
      const extra = toMonacoEdits(
        resolved.additionalTextEdits as LspTextEdit[] | undefined,
      );
      if (extra) item.additionalTextEdits = extra;
      return item;
    },
  });

  monaco.languages.registerHoverProvider(MONACO_LANGS, {
    async provideHover(model, position) {
      const serverId = serverIdForLanguage(model.getLanguageId());
      if (!serverId || !startedServers.has(serverId)) return null;
      const res = (await window.logos.lsp
        .request(serverId, "textDocument/hover", {
          textDocument: { uri: model.uri.toString() },
          position: lspPos(position),
        })
        .catch(() => null)) as { contents?: unknown; range?: LspRange } | null;
      if (!res?.contents) return null;
      const value = markupValue(res.contents);
      if (!value) return null;
      return {
        contents: [{ value }],
        range: res.range ? toMonacoRange(res.range) : undefined,
      };
    },
  });

  monaco.languages.registerDefinitionProvider(MONACO_LANGS, {
    async provideDefinition(model, position) {
      const serverId = serverIdForLanguage(model.getLanguageId());
      if (!serverId || !startedServers.has(serverId)) return null;
      const res = (await window.logos.lsp
        .request(serverId, "textDocument/definition", {
          textDocument: { uri: model.uri.toString() },
          position: lspPos(position),
        })
        .catch(() => null)) as unknown;
      if (!res) return null;
      const arr = Array.isArray(res) ? res : [res];
      return arr
        .map((loc) => {
          const l = loc as {
            uri?: string;
            targetUri?: string;
            range?: LspRange;
            targetRange?: LspRange;
          };
          const uri = l.uri ?? l.targetUri;
          const range = l.range ?? l.targetRange;
          if (!uri || !range) return null;
          return {
            uri: monaco.Uri.parse(uri),
            range: toMonacoRange(range),
          };
        })
        .filter((x): x is monaco.languages.Location => x !== null);
    },
  });

  // Diagnostics -> Monaco markers + Problems store.
  window.logos.lsp.onNotify(({ method, params }) => {
    if (method !== "textDocument/publishDiagnostics") return;
    const p = params as {
      uri: string;
      diagnostics: Array<{
        range: LspRange;
        message: string;
        severity?: number;
        source?: string;
      }>;
    };
    const uri = monaco.Uri.parse(p.uri);
    const model = monaco.editor.getModel(uri);
    const markers: monaco.editor.IMarkerData[] = p.diagnostics.map((d) => ({
      message: d.message,
      severity: severityToMonaco(d.severity ?? 1),
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      source: d.source,
    }));
    if (model) monaco.editor.setModelMarkers(model, "logos-lsp", markers);

    const diags: Diagnostic[] = p.diagnostics.map((d) => ({
      message: d.message,
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
      for (const model of monaco.editor.getModels()) {
        if (serverIdForLanguage(model.getLanguageId()) === p.id)
          openDocs.delete(model.uri.fsPath);
      }
    } else if (p.status === "running") {
      startedServers.add(p.id);
      reopenModelsFor(p.id);
      // C2: a cold server just came up — re-trigger suggest on the focused
      // editor so members appear without deleting/retyping.
      window.dispatchEvent(
        new CustomEvent("logos:lsp-ready", { detail: { serverId: p.id } }),
      );
    }
  });

  // A1: when a folder is opened (root null -> set), re-attempt servers for any
  // documents that were opened on the Welcome screen before a root existed.
  useStore.subscribe((state, prev) => {
    if (state.root !== prev.root && state.root) ensureServersForOpenModels();
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
