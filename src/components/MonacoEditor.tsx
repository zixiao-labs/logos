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
import type { DebugBreakpointState } from "../shared/dap";

/** path -> last-saved content, for dirty tracking. */
const baselines = new Map<string, string>();
const EMPTY_DEBUG_BREAKPOINTS: DebugBreakpointState[] = [];
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
    glyphMargin: true,
  };
}

interface MonacoEditorProps {
  path: string;
  language: string;
  content?: string;
  readOnly?: boolean;
  debugPosition?: { line: number; column: number };
}

export function MonacoEditor({
  path,
  language,
  content: providedContent,
  readOnly = false,
  debugPosition,
}: MonacoEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const breakpointDecorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const stackDecorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const settings = useStore((s) => s.settings);
  const setDirty = useStore((s) => s.setDirty);
  const setCursor = useStore((s) => s.setCursor);
  const breakpoints = useStore(
    (s) => s.debug.breakpoints[path] ?? EMPTY_DEBUG_BREAKPOINTS,
  );
  const activeDebugSessionId = useStore((s) => s.debug.activeSessionId);
  const selectedFrame = useStore((s) =>
    s.debug.stackFrames.find((frame) => frame.id === s.debug.selectedFrameId),
  );

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
      readOnly,
      ...editorOptions(useStore.getState().settings),
    });
    editorRef.current = editor;
    breakpointDecorationsRef.current = editor.createDecorationsCollection();
    stackDecorationsRef.current = editor.createDecorationsCollection();

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
    const mouseSub = editor.onMouseDown((event) => {
      if (readOnly) return;
      if (
        event.target.type !==
          monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !event.target.position
      ) return;
      const debug = useStore.getState().debug;
      const existing = (debug.breakpoints[path] ?? []).find((breakpoint) => {
        const sessionData = debug.activeSessionId
          ? breakpoint.sessionData?.[debug.activeSessionId]
          : undefined;
        return (
          (sessionData?.line ?? breakpoint.line) ===
          event.target.position!.lineNumber
        );
      });
      void useStore
        .getState()
        .toggleBreakpoint(
          path,
          existing?.line ?? event.target.position.lineNumber,
        );
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (readOnly) return;
      void saveCurrent(editor, setDirty);
    });
    const onSave = () => {
      if (!readOnly) void saveCurrent(editor, setDirty);
    };
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
      mouseSub.dispose();
      breakpointDecorationsRef.current = null;
      stackDecorationsRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the model when the active file changes.
  useEffect(() => {
    let cancelled = false;
    const uri = providedContent === undefined
      ? monaco.Uri.file(path)
      : monaco.Uri.parse(path);
    (async () => {
      let model = monaco.editor.getModel(uri);
      if (!model) {
        const content =
          providedContent ??
          (await window.logos.fs.readFile(path).catch(() => ""));
        if (cancelled) return;
        model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(content, language, uri);
          if (providedContent === undefined) {
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
      } else if (
        providedContent !== undefined &&
        model.getValue() !== providedContent
      ) {
        model.setValue(providedContent);
      }
      const editor = editorRef.current;
      editor?.setModel(model);
      if (editor) {
        updateBreakpointDecorations(
          breakpointDecorationsRef.current,
          useStore.getState().debug.breakpoints[path] ?? EMPTY_DEBUG_BREAKPOINTS,
          useStore.getState().debug.activeSessionId,
        );
        updateStackFrameDecoration(
          editor,
          stackDecorationsRef.current,
          path,
          readOnly,
        );
      }
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
  }, [language, path, providedContent, readOnly, setDirty]);

  useEffect(() => {
    updateBreakpointDecorations(
      breakpointDecorationsRef.current,
      breakpoints,
      activeDebugSessionId,
    );
  }, [activeDebugSessionId, breakpoints]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    updateStackFrameDecoration(
      editor,
      stackDecorationsRef.current,
      path,
      readOnly,
    );
  }, [path, readOnly, selectedFrame]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !readOnly) return;
    if (!debugPosition) {
      stackDecorationsRef.current?.clear();
      return;
    }
    const position = {
      lineNumber: debugPosition.line,
      column: debugPosition.column,
    };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    stackDecorationsRef.current?.set([
      {
        range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
        options: { isWholeLine: true, className: "logos-debug-stack-line" },
      },
    ]);
  }, [debugPosition, readOnly]);

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

function updateBreakpointDecorations(
  collection: monaco.editor.IEditorDecorationsCollection | null,
  breakpoints: DebugBreakpointState[],
  activeSessionId: string | null,
): void {
  collection?.set(
    breakpoints.map((breakpoint) => {
      const sessionData = activeSessionId
        ? breakpoint.sessionData?.[activeSessionId]
        : undefined;
      return {
        range: new monaco.Range(
          sessionData?.line ?? breakpoint.line,
          1,
          sessionData?.line ?? breakpoint.line,
          1,
        ),
        options: {
          isWholeLine: true,
          glyphMarginClassName: sessionData?.verified
            ? "logos-breakpoint-glyph"
            : "logos-breakpoint-glyph-unverified",
          glyphMarginHoverMessage: {
            value:
              sessionData?.message ?? `Breakpoint at line ${breakpoint.line}`,
          },
        },
      };
    }),
  );
}

function updateStackFrameDecoration(
  editor: monaco.editor.IStandaloneCodeEditor,
  collection: monaco.editor.IEditorDecorationsCollection | null,
  path: string,
  readOnly: boolean,
): void {
  if (readOnly) return;
  const debug = useStore.getState().debug;
  const frame = debug.stackFrames.find(
    (candidate) => candidate.id === debug.selectedFrameId,
  );
  if (frame?.source?.path !== path) {
    collection?.clear();
    return;
  }
  const position = {
    lineNumber: Math.max(frame.line, 1),
    column: Math.max(frame.column, 1),
  };
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  collection?.set([
    {
      range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
      options: { isWholeLine: true, className: "logos-debug-stack-line" },
    },
  ]);
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

export async function closeTabSafely(id: string) {
  const { tabs, closeTab } = useStore.getState();
  const tab = tabs.find((item) => item.id === id);
  if (
    tab?.kind === "file" &&
    tab.path &&
    !(await closeFileEditor(tab.path, Boolean(tab.dirty)))
  ) return false;
  if (tab?.kind === "debug-source" && tab.path) {
    monaco.editor.getModel(monaco.Uri.parse(tab.path))?.dispose();
  }
  closeTab(id);
  return true;
}
