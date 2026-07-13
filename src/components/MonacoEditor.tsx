import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useStore } from "../state/store";
import {
  lspChangeDoc,
  lspCloseDoc,
  lspOpenDoc,
  lspSaveDoc,
  lspWillSaveDoc,
  showLspHierarchy,
  showLspMonikers,
  takeLspNavigationTarget,
} from "../lib/lsp-monaco";
import { serverIdForLanguage } from "../lib/language";

/** path -> last-saved content, for dirty tracking. */
const baselines = new Map<string, string>();
let themesDefined = false;

function defineThemes() {
  if (themesDefined) return;
  themesDefined = true;
  monaco.editor.defineTheme("logos-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#121215",
      "editor.lineHighlightBackground": "#1c1c22",
      "editorLineNumber.foreground": "#4a4a55",
      "editorGutter.background": "#121215",
      "editorWidget.background": "#1a1a20",
      "editor.selectionBackground": "#33335a",
    },
  });
  monaco.editor.defineTheme("logos-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fbfbfc",
      "editor.lineHighlightBackground": "#f0f0f3",
    },
  });
}

function editorOptions(
  settings: ReturnType<typeof useStore.getState>["settings"],
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize: settings["editor.fontSize"],
    fontFamily: settings["editor.fontFamily"],
    tabSize: settings["editor.tabSize"],
    wordWrap: settings["editor.wordWrap"],
    minimap: { enabled: settings["editor.minimap"] },
    lineNumbers: settings["editor.lineNumbers"],
  };
}

interface MonacoEditorProps {
  path: string;
  language: string;
}

export function MonacoEditor({ path, language }: MonacoEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const settings = useStore((s) => s.settings);
  const setDirty = useStore((s) => s.setDirty);
  const setCursor = useStore((s) => s.setCursor);

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return;
    defineThemes();
    const editor = monaco.editor.create(hostRef.current, {
      automaticLayout: true,
      theme:
        useStore.getState().settings["workbench.theme"] === "dark"
          ? "logos-dark"
          : "logos-light",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      padding: { top: 8 },
      fixedOverflowWidgets: true,
      ...editorOptions(useStore.getState().settings),
    });
    editorRef.current = editor;

    for (const [id, label, run] of [
      ["incomingCalls", "Show Incoming Calls", () => showLspHierarchyForEditor(editor, "incoming")],
      ["outgoingCalls", "Show Outgoing Calls", () => showLspHierarchyForEditor(editor, "outgoing")],
      ["supertypes", "Show Supertypes", () => showLspHierarchyForEditor(editor, "supertypes")],
      ["subtypes", "Show Subtypes", () => showLspHierarchyForEditor(editor, "subtypes")],
      ["monikers", "Show Symbol Monikers", () => showLspMonikersForEditor(editor)],
    ] as const) {
      editor.addAction({
        id: `logos.lsp.${id}`,
        label,
        contextMenuGroupId: "navigation",
        run,
      });
    }

    const cursorSub = editor.onDidChangeCursorPosition((e) =>
      setCursor(e.position.lineNumber, e.position.column),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveCurrent(editor, setDirty);
    });
    const onSave = () => void saveCurrent(editor, setDirty);
    window.addEventListener("logos:save", onSave);

    // C2: when a cold language server becomes ready, re-trigger the suggest
    // widget on the focused editor so completions appear without retyping.
    const onLspReady = (e: Event) => {
      if (!editor.hasTextFocus()) return;
      const model = editor.getModel();
      if (!model) return;
      const { serverId } = (e as CustomEvent<{ serverId: string }>).detail;
      if (serverIdForLanguage(model.getLanguageId()) !== serverId) return;
      editor.trigger("lsp", "editor.action.triggerSuggest", {});
    };
    window.addEventListener("logos:lsp-ready", onLspReady);
    const onNavigate = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          path: string;
          target: monaco.IRange | monaco.IPosition;
          takeFocus?: boolean;
        }>
      ).detail;
      const model = editor.getModel();
      if (!model || model.uri.fsPath !== detail.path) return;
      if ("startLineNumber" in detail.target) {
        editor.setSelection(detail.target);
        editor.revealRangeInCenter(detail.target);
      } else {
        editor.setPosition(detail.target);
        editor.revealPositionInCenter(detail.target);
      }
      if (detail.takeFocus !== false) editor.focus();
      takeLspNavigationTarget(detail.path);
    };
    window.addEventListener("logos:lsp-navigate", onNavigate);

    return () => {
      window.removeEventListener("logos:save", onSave);
      window.removeEventListener("logos:lsp-ready", onLspReady);
      window.removeEventListener("logos:lsp-navigate", onNavigate);
      cursorSub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the model when the active file changes.
  useEffect(() => {
    let cancelled = false;
    const uri = monaco.Uri.file(path);
    (async () => {
      let model = monaco.editor.getModel(uri);
      if (!model) {
        const content = await window.logos.fs.readFile(path).catch(() => "");
        if (cancelled) return;
        model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(content, language, uri);
          baselines.set(path, content);
          let version = 1;
          model.onDidChangeContent((event) => {
            const m = model!;
            setDirty(`file:${path}`, m.getValue() !== baselines.get(path));
            lspChangeDoc(
              path,
              language,
              m.getValue(),
              ++version,
              event.changes.map((change) => ({
                range: change.range,
                rangeLength: change.rangeLength,
                text: change.text,
              })),
            );
          });
          lspOpenDoc(path, language, content);
        }
      }
      const editor = editorRef.current;
      editor?.setModel(model);
      const target = takeLspNavigationTarget(path);
      if (editor && target) {
        if ("startLineNumber" in target) {
          editor.setSelection(target);
          editor.revealRangeInCenter(target);
        } else {
          editor.setPosition(target);
          editor.revealPositionInCenter(target);
        }
        editor.focus();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, language, setDirty]);

  // Apply settings live.
  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(settings));
    monaco.editor.setTheme(
      settings["workbench.theme"] === "dark" ? "logos-dark" : "logos-light",
    );
  }, [settings]);

  return <div className="monaco-container" ref={hostRef} />;
}

async function saveCurrent(
  editor: monaco.editor.IStandaloneCodeEditor,
  setDirty: (id: string, dirty: boolean) => void,
) {
  const model = editor.getModel();
  if (!model) return;
  const p = model.uri.fsPath;
  await lspWillSaveDoc(p, model.getLanguageId());
  const content = model.getValue();
  await window.logos.fs.writeFile(p, content);
  baselines.set(p, content);
  setDirty(`file:${p}`, false);
  // F1: tell the language server the document was saved (save-time linting).
  lspSaveDoc(p, model.getLanguageId(), content);
}

function showLspHierarchyForEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  kind: "incoming" | "outgoing" | "supertypes" | "subtypes",
) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (model && position) void showLspHierarchy(model, position, kind);
}

function showLspMonikersForEditor(editor: monaco.editor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (model && position) void showLspMonikers(model, position);
}

export function disposeModel(path: string) {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  lspCloseDoc(path);
  model?.dispose();
  baselines.delete(path);
}

export async function closeFileEditor(path: string, dirty: boolean) {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (dirty) {
    const choice = await new Promise<{ title: string } | null>((resolve) => {
      window.dispatchEvent(
        new CustomEvent("logos:lsp-message-request", {
          detail: {
            type: 2,
            message: `Save changes to ${path}?`,
            actions: [{ title: "Save" }, { title: "Don't Save" }],
            resolve,
          },
        }),
      );
    });
    if (!choice) return false;
    if (choice.title === "Save" && model) {
      try {
        await lspWillSaveDoc(path, model.getLanguageId());
        const content = model.getValue();
        await window.logos.fs.writeFile(path, content);
        baselines.set(path, content);
        useStore.getState().setDirty(`file:${path}`, false);
        lspSaveDoc(path, model.getLanguageId(), content);
      } catch {
        return false;
      }
    }
  }
  disposeModel(path);
  return true;
}
