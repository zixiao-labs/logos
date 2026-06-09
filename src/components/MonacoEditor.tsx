import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useStore } from "../state/store";
import {
  lspChangeDoc,
  lspCloseDoc,
  lspOpenDoc,
  lspSaveDoc,
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

    return () => {
      window.removeEventListener("logos:save", onSave);
      window.removeEventListener("logos:lsp-ready", onLspReady);
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
          model.onDidChangeContent(() => {
            const m = model!;
            setDirty(`file:${path}`, m.getValue() !== baselines.get(path));
            lspChangeDoc(path, language, m.getValue(), ++version);
          });
          lspOpenDoc(path, language, content);
        }
      }
      editorRef.current?.setModel(model);
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
  const content = model.getValue();
  await window.logos.fs.writeFile(p, content);
  baselines.set(p, content);
  setDirty(`file:${p}`, false);
  // F1: tell the language server the document was saved (save-time linting).
  lspSaveDoc(p, model.getLanguageId(), content);
}

export function disposeModel(path: string) {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  model?.dispose();
  baselines.delete(path);
  lspCloseDoc(path);
}
