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
const startAttempts = new Set<string>();
const openDocs = new Set<string>();

function uriOf(path: string): string {
  return monaco.Uri.file(path).toString();
}

async function ensureServer(monacoLang: string): Promise<string | null> {
  const serverId = serverIdForLanguage(monacoLang);
  if (!serverId) return null;
  if (startedServers.has(serverId)) return serverId;
  if (startAttempts.has(serverId)) return null; // in-flight or failed
  startAttempts.add(serverId);

  const root = useStore.getState().root;
  if (!root) return null;
  try {
    const servers = await window.logos.lsp.list();
    const info = servers.find((s) => s.id === serverId);
    if (!info) return null;
    if (info.status === "not-installed") {
      if (!useStore.getState().settings["lsp.autoDownload"]) return null;
      await window.logos.lsp.install(serverId);
    }
    await window.logos.lsp.start(serverId, root);
    startedServers.add(serverId);
    return serverId;
  } catch {
    return null;
  }
}

export function lspOpenDoc(path: string, monacoLang: string, content: string) {
  void (async () => {
    const serverId = await ensureServer(monacoLang);
    if (!serverId) return;
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
  if (!serverId || !startedServers.has(serverId) || !openDocs.has(path)) return;
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

let providersRegistered = false;

export function setupLspMonaco() {
  if (providersRegistered) return;
  providersRegistered = true;

  monaco.languages.registerCompletionItemProvider(MONACO_LANGS, {
    triggerCharacters: [".", '"', "'", "/", "@", "<", ":", " "],
    async provideCompletionItems(model, position) {
      const lang = model.getLanguageId();
      const serverId = serverIdForLanguage(lang);
      if (!serverId || !startedServers.has(serverId)) return { suggestions: [] };
      const res = (await window.logos.lsp
        .request(serverId, "textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: lspPos(position),
        })
        .catch(() => null)) as
        | { items?: unknown[] }
        | unknown[]
        | null;
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions = (items as Array<Record<string, unknown>>).map(
        (it): monaco.languages.CompletionItem => ({
          label: String(it.label ?? ""),
          kind: COMPLETION_KIND[(it.kind as number) ?? 1] ?? 0,
          insertText: String(it.insertText ?? it.label ?? ""),
          detail: it.detail as string | undefined,
          documentation: it.documentation
            ? { value: markupValue(it.documentation) }
            : undefined,
          range,
          sortText: it.sortText as string | undefined,
        }),
      );
      return { suggestions };
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
