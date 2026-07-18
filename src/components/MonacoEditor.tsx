import { useEffect, useRef, useState } from "react";
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
import { createInlineBlameDecorationOptions } from "../lib/git-blame";
import type { DebugBreakpointState } from "../shared/dap";
import type { FileSnapshot } from "../shared/types";

/** path -> last-saved content, for dirty tracking. */
const baselines = new Map<string, string>();
const baselineRevisions = new Map<string, string>();
const watchVersions = new Map<string, number>();
const EMPTY_DEBUG_BREAKPOINTS: DebugBreakpointState[] = [];
let themesDefined = false;
let fileSyncSetup = false;

/** Keep open Monaco models coherent with agent and external filesystem writes. */
export function setupMonacoFileSync(): void {
  if (fileSyncSetup) return;
  fileSyncSetup = true;
  window.logos.fs.onWatchEvent((event) => {
    const version = (watchVersions.get(event.path) ?? 0) + 1;
    watchVersions.set(event.path, version);
    const model = monaco.editor.getModel(monaco.Uri.file(event.path));
    if (!model) return;
    const tabId = `file:${event.path}`;
    if (event.type === "delete") {
      useStore.setState((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tabId ? { ...item, externalChange: "deleted" } : item,
        ),
      }));
      return;
    }
    void window.logos.fs
      .readFileSnapshot(event.path)
      .then((snapshot) => {
        if (
          watchVersions.get(event.path) !== version ||
          monaco.editor.getModel(monaco.Uri.file(event.path)) !== model
        ) return;
        if (!snapshot.exists) {
          useStore.setState((state) => ({
            tabs: state.tabs.map((item) =>
              item.id === tabId ? { ...item, externalChange: "deleted" } : item,
            ),
          }));
          return;
        }
        const content = snapshot.content;
        if (model.getValue() === content) {
          baselines.set(event.path, content);
          baselineRevisions.set(event.path, snapshot.revision);
          useStore.setState((state) => ({
            tabs: state.tabs.map((item) =>
              item.id === tabId
                ? { ...item, dirty: false, externalChange: undefined }
                : item,
            ),
          }));
          return;
        }
        const current = useStore.getState().tabs.find((item) => item.id === tabId);
        if (current?.dirty) {
          useStore.setState((state) => ({
            tabs: state.tabs.map((item) =>
              item.id === tabId ? { ...item, externalChange: "changed" } : item,
            ),
          }));
          return;
        }
        baselines.set(event.path, content);
        baselineRevisions.set(event.path, snapshot.revision);
        model.setValue(content);
        useStore.setState((state) => ({
          tabs: state.tabs.map((item) =>
            item.id === tabId
              ? { ...item, dirty: false, externalChange: undefined }
              : item,
          ),
        }));
      })
      .catch(() => undefined);
  });
}

export async function reloadFileFromDisk(path: string): Promise<void> {
  const version = (watchVersions.get(path) ?? 0) + 1;
  watchVersions.set(path, version);
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const snapshot = await window.logos.fs.readFileSnapshot(path);
  if (!snapshot.exists) throw new Error(`${path} no longer exists`);
  if (
    watchVersions.get(path) !== version ||
    monaco.editor.getModel(monaco.Uri.file(path)) !== model
  ) return;
  applyDiskSnapshot(path, snapshot);
}

function applyDiskSnapshot(
  path: string,
  snapshot: Extract<FileSnapshot, { exists: true }>,
): void {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  baselines.set(path, snapshot.content);
  baselineRevisions.set(path, snapshot.revision);
  model?.setValue(snapshot.content);
  useStore.setState((state) => ({
    tabs: state.tabs.map((item) =>
      item.id === `file:${path}`
        ? { ...item, dirty: false, externalChange: undefined }
        : item,
    ),
  }));
}

async function confirmExternalOverwrite(path: string): Promise<string | null> {
  let externalChange = useStore
    .getState()
    .tabs.find((item) => item.id === `file:${path}`)?.externalChange;
  const snapshot = await window.logos.fs.readFileSnapshot(path);
  const baselineRevision = baselineRevisions.get(path);
  const baseline = baselines.get(path);
  if (
    snapshot.revision === baselineRevision ||
    (baselineRevision === undefined && snapshot.exists && snapshot.content === baseline)
  ) {
    baselineRevisions.set(path, snapshot.revision);
    if (externalChange) {
      useStore.setState((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === `file:${path}`
            ? { ...item, externalChange: undefined }
            : item,
        ),
      }));
    }
    return snapshot.revision;
  }
  externalChange = snapshot.exists ? "changed" : "deleted";
  useStore.setState((state) => ({
    tabs: state.tabs.map((item) =>
      item.id === `file:${path}` ? { ...item, externalChange } : item,
    ),
  }));
  const overwriteTitle = externalChange === "deleted" ? "Recreate" : "Overwrite";
  const choice = await new Promise<{ title: string } | null>((resolve) => {
    window.dispatchEvent(
      new CustomEvent("logos:lsp-message-request", {
        detail: {
          type: 2,
          message:
            externalChange === "deleted"
              ? `${path} was deleted outside Logos. Recreate it with your editor contents?`
              : `${path} changed on disk. Overwrite the external changes?`,
          actions: [
            { title: overwriteTitle },
            ...(externalChange === "changed" ? [{ title: "Reload" }] : []),
            { title: "Cancel" },
          ],
          resolve,
        },
      }),
    );
  });
  if (choice?.title === "Reload") {
    try {
      await reloadFileFromDisk(path);
    } catch {
      const latest = await window.logos.fs.readFileSnapshot(path);
      if (!latest.exists) markExternalConflict(path, latest);
      else throw new Error(`Failed to reload ${path}`);
    }
    return null;
  }
  return choice?.title === overwriteTitle ? snapshot.revision : null;
}

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
  const inlineBlameDecorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const blameRequestRef = useRef(0);
  const [modelVersion, setModelVersion] = useState(0);
  const [blameRefreshVersion, setBlameRefreshVersion] = useState(0);
  const settings = useStore((s) => s.settings);
  const inlineBlameEnabled = settings["git.blame.inline.enabled"];
  const statusBarBlameEnabled = settings["git.blame.statusBar.enabled"];
  const languageCode = settings["workbench.language"];
  const root = useStore((s) => s.root);
  const isGitRepo = useStore((s) => s.git?.isRepo ?? false);
  const gitHeadHash = useStore((s) => s.gitHead?.hash ?? "");
  const cursorLine = useStore((s) => s.cursor.line);
  const dirty = useStore(
    (s) => s.tabs.find((tab) => tab.id === `file:${path}`)?.dirty ?? false,
  );
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
    inlineBlameDecorationsRef.current = editor.createDecorationsCollection();

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
      inlineBlameDecorationsRef.current = null;
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
        const snapshot =
          providedContent === undefined
            ? await window.logos.fs.readFileSnapshot(path).catch(() => null)
            : null;
        const content =
          providedContent ?? (snapshot?.exists ? snapshot.content : "");
        if (cancelled) return;
        model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(content, language, uri);
          if (providedContent === undefined) {
            baselines.set(path, content);
            if (snapshot) baselineRevisions.set(path, snapshot.revision);
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
        const position = editor.getPosition();
        if (position) setCursor(position.lineNumber, position.column);
        setModelVersion((version) => version + 1);
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
  }, [language, path, providedContent, readOnly, setCursor, setDirty]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const subscription = model.onDidChangeContent(() => {
      ++blameRequestRef.current;
      inlineBlameDecorationsRef.current?.clear();
      const current = useStore.getState().currentLineBlame;
      if (current?.path === path) {
        useStore.getState().setCurrentLineBlame(null);
      }
      if (model.getValue() === baselines.get(path)) {
        setBlameRefreshVersion((version) => version + 1);
      }
    });
    return () => subscription.dispose();
  }, [modelVersion, path]);

  useEffect(() => {
    const requestVersion = ++blameRequestRef.current;
    const editor = editorRef.current;
    const collection = inlineBlameDecorationsRef.current;
    collection?.clear();
    const current = useStore.getState().currentLineBlame;
    if (current?.path === path) {
      useStore.getState().setCurrentLineBlame(null);
    }

    const model = editor?.getModel();
    if (
      !root ||
      !isGitRepo ||
      !editor ||
      !model ||
      readOnly ||
      providedContent !== undefined ||
      dirty ||
      (!inlineBlameEnabled && !statusBarBlameEnabled) ||
      cursorLine < 1 ||
      cursorLine > model.getLineCount() ||
      model.getValue() !== baselines.get(path)
    ) return;

    const contentVersion = model.getVersionId();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.logos.git
        .blame(root, path, cursorLine)
        .catch(() => null)
        .then((blame) => {
          if (
            cancelled ||
            requestVersion !== blameRequestRef.current ||
            editor.getModel() !== model ||
            model.getVersionId() !== contentVersion ||
            editor.getPosition()?.lineNumber !== cursorLine ||
            model.getValue() !== baselines.get(path)
          ) return;
          const state = useStore.getState();
          const active = state.tabs.find((tab) => tab.id === state.activeTabId);
          if (
            active?.kind !== "file" ||
            active.path !== path ||
            active.dirty ||
            !blame
          ) return;

          state.setCurrentLineBlame({ path, line: cursorLine, blame });
          if (!inlineBlameEnabled) return;
          const endColumn = model.getLineMaxColumn(cursorLine);
          collection?.set([
            {
              range: new monaco.Range(
                cursorLine,
                endColumn,
                cursorLine,
                endColumn,
              ),
              options: createInlineBlameDecorationOptions(
                blame,
                languageCode,
                monaco.editor.InjectedTextCursorStops.None,
              ),
            },
          ]);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      collection?.clear();
      const latest = useStore.getState().currentLineBlame;
      if (latest?.path === path && latest.line === cursorLine) {
        useStore.getState().setCurrentLineBlame(null);
      }
    };
  }, [
    blameRefreshVersion,
    cursorLine,
    dirty,
    gitHeadHash,
    inlineBlameEnabled,
    isGitRepo,
    languageCode,
    modelVersion,
    path,
    providedContent,
    readOnly,
    root,
    statusBarBlameEnabled,
  ]);

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
  const expectedRevision = await confirmExternalOverwrite(p);
  if (!expectedRevision) return;
  await lspWillSaveDoc(p, model.getLanguageId());
  const content = model.getValue();
  const result = await window.logos.fs.writeFileConditional(
    p,
    content,
    expectedRevision,
  );
  if (result.status === "conflict") {
    markExternalConflict(p, result.current);
    return;
  }
  baselines.set(p, content);
  baselineRevisions.set(p, result.revision);
  setDirty(`file:${p}`, model.getValue() !== content);
  useStore.setState((state) => ({
    tabs: state.tabs.map((item) =>
      item.id === `file:${p}` ? { ...item, externalChange: undefined } : item,
    ),
  }));
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
  baselineRevisions.delete(path);
  watchVersions.set(path, (watchVersions.get(path) ?? 0) + 1);
}

function markExternalConflict(path: string, snapshot: FileSnapshot): void {
  useStore.setState((state) => ({
    tabs: state.tabs.map((item) =>
      item.id === `file:${path}`
        ? {
            ...item,
            externalChange: snapshot.exists ? "changed" : "deleted",
          }
        : item,
    ),
  }));
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
        const expectedRevision = await confirmExternalOverwrite(path);
        if (!expectedRevision) return false;
        await lspWillSaveDoc(path, model.getLanguageId());
        const content = model.getValue();
        const result = await window.logos.fs.writeFileConditional(
          path,
          content,
          expectedRevision,
        );
        if (result.status === "conflict") {
          markExternalConflict(path, result.current);
          return false;
        }
        baselines.set(path, content);
        baselineRevisions.set(path, result.revision);
        useStore.getState().setDirty(`file:${path}`, false);
        useStore.setState((state) => ({
          tabs: state.tabs.map((item) =>
            item.id === `file:${path}`
              ? { ...item, externalChange: undefined }
              : item,
          ),
        }));
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
