import * as monaco from "monaco-editor";
import { create } from "zustand";
import { useStore } from "../state/store";
import type { KeymapMode } from "../shared/types";
import { HelixController } from "./helix";
import type { ModalActions, ModalUI } from "./modal-types";
import type { VimAdapterInstance, VimMode } from "monaco-vim";

interface EditorModeState {
  editorId: string | null;
  keymap: KeymapMode;
  mode: string;
  pending: string;
}

export const useEditorMode = create<EditorModeState>(() => ({
  editorId: null, keymap: "default", mode: "normal", pending: "",
}));

// Ex definitions are global in the Vim engine. Route them to the adapter that
// invoked the command, never to whichever editor happens to be focused later.
const vimCommands = new WeakMap<VimAdapterInstance, (value: string) => void>();
let vimConfigured = false;
function configureVim(Vim: typeof VimMode) {
  if (vimConfigured) return;
  vimConfigured = true;
  // monaco-vim's public types omit the CodeMirror Vim extension.
  const api = (Vim as typeof Vim & { Vim: {
    defineEx(name: string, prefix: string, callback: (adapter: VimAdapterInstance, params: { argString?: string }) => void): void;
  } }).Vim;
  for (const [name, short] of [["write", "w"], ["quit", "q"], ["wq", "wq"], ["xit", "x"], ["bnext", "bn"], ["bprevious", "bp"]]) {
    api.defineEx(name, short, (adapter, params) => {
      vimCommands.get(adapter)?.(name + (params.argString ? ` ${params.argString}` : ""));
    });
  }
  // The upstream undo/redo commands call model.undo directly, which bypasses
  // Monaco's readOnly editor option. Guard both normal and Ex entry points.
  for (const command of ["undo", "redo"] as const) {
    const original = Vim.commands[command];
    Vim.commands[command] = adapter => {
      if (!adapter.getOption("readOnly")) original(adapter);
    };
    api.defineEx(command, command === "undo" ? "u" : "red", adapter => Vim.commands[command](adapter));
  }
}

/** Attach once per editor; model changes and live keymap settings reset modes. */
export function bindEditorKeymap(
  editor: monaco.editor.IStandaloneCodeEditor,
  actions: ModalActions = {},
): monaco.IDisposable {
  const editorId = editor.getId();
  const original = editor.getRawOptions();
  const defaults: monaco.editor.IEditorOptions = {
    cursorStyle: original.cursorStyle ?? "line",
    cursorBlinking: original.cursorBlinking ?? "blink",
    cursorWidth: original.cursorWidth ?? 0,
    domReadOnly: original.domReadOnly ?? false,
    editContext: original.editContext ?? true,
  };
  let version = 0;
  let disposed = false;
  let cleanup: (() => void) | undefined;
  let mode: KeymapMode = useStore.getState().settings["workbench.keymap"];

  const reset = () => {
    const generation = ++version;
    cleanup?.();
    cleanup = undefined;
    editor.updateOptions(defaults);
    if (useEditorMode.getState().editorId === editorId) useEditorMode.setState({ editorId: null, keymap: "default" });
    if (disposed || mode === "default" || !editor.getModel()) return;

    // Native EditContext does not honor domReadOnly. Use Monaco's supported
    // textarea input while modal editing is active so IME cannot type in Normal.
    editor.updateOptions({ editContext: false });

    const keymap = mode;
    const model = editor.getModel()!;
    const node = document.createElement("div");
    node.className = "editor-modal-status";
    node.dataset.keymap = keymap;
    node.setAttribute("aria-label", `${keymap === "vim" ? "Vim" : "Helix"} command line`);
    const label = document.createElement("span");
    label.className = "editor-modal-label";
    label.textContent = keymap.toUpperCase();
    const content = document.createElement("span");
    content.className = "editor-modal-content";
    const message = document.createElement("span");
    message.className = "editor-modal-message";
    message.setAttribute("role", "status");
    node.append(label, content, message);
    const widget: monaco.editor.IOverlayWidget = {
      getId: () => `logos.modal.${editorId}`,
      getDomNode: () => node,
      getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER }),
    };
    editor.addOverlayWidget(widget);
    let currentMode = "normal";
    let pending = "";
    let closing = false;
    let controller: monaco.IDisposable | undefined;
    const alive = () => !disposed && generation === version && editor.getModel() === model;
    const syncInput = () => {
      const input = editor.getDomNode()?.querySelector<HTMLTextAreaElement>("textarea.inputarea");
      // Monaco only applies domReadOnly when readOnly is also true. Modal
      // commands still need executeEdits, so lock the DOM input independently.
      if (input) input.readOnly = currentMode !== "insert" || editor.getOption(monaco.editor.EditorOption.readOnly);
    };
    const publish = () => {
      if (!alive()) return;
      syncInput();
      const focused = editor.hasWidgetFocus() || node.contains(document.activeElement);
      node.hidden = !focused;
      if (focused) useEditorMode.setState({ editorId, keymap, mode: currentMode, pending });
      else if (useEditorMode.getState().editorId === editorId) useEditorMode.setState({ editorId: null, keymap: "default" });
    };
    const notify = (text: string) => {
      if (!alive()) return;
      message.textContent = text;
    };
    const command = (raw: string) => {
      const value = raw.trim();
      const [name, ...args] = value.split(/\s+/);
      const save = ["w", "write", "wq", "x", "xit"].includes(name);
      const close = ["q", "quit", "wq", "x", "xit"].includes(name);
      if ((save || close) && args.length) { notify("This command does not accept a file argument"); return; }
      if (save && (editor.getOption(monaco.editor.EditorOption.readOnly) || !actions.save)) { notify("Read-only editor"); return; }
      if (close && !actions.close) { notify("Close is unavailable in this editor"); return; }
      if (save || close) {
        void (async () => {
          try {
            if (save && !(await actions.save!())) return;
            if (!alive()) return;
            if (close) await actions.close!();
            else notify("Written");
          } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
        })();
      } else if (["bn", "bnext", "bp", "bprevious"].includes(name)) {
        const state = useStore.getState();
        const index = state.tabs.findIndex(tab => tab.id === state.activeTabId);
        const next = (index + (name === "bn" || name === "bnext" ? 1 : -1) + state.tabs.length) % state.tabs.length;
        if (state.tabs[next]) state.setActiveTab(state.tabs[next].id);
      } else if (/^\d+$/.test(name)) {
        editor.setPosition({ lineNumber: Math.min(model.getLineCount(), Math.max(1, Number(name))), column: 1 });
        editor.revealPositionInCenter(editor.getPosition()!);
      } else if (actions.command) actions.command(value);
      else notify(`Unknown command: ${name}`);
    };
    const ui: ModalUI = {
      mode: (value, keys = "") => {
        currentMode = value;
        pending = keys;
        node.dataset.mode = value;
        syncInput();
        if (!content.querySelector("input")) content.textContent = `${value.toUpperCase()}${keys ? `  ${keys}` : ""}`;
        publish();
      },
      notify,
      command,
      prompt: (prefix, submit, initial = "") => {
        message.textContent = "";
        content.replaceChildren();
        const prefixNode = document.createElement("span");
        prefixNode.textContent = prefix;
        const input = document.createElement("input");
        input.setAttribute("aria-label", prefix === ":" ? "Helix command" : `Helix ${prefix}`);
        input.spellcheck = false;
        input.value = initial;
        content.append(prefixNode, input);
        let finished = false;
        const finish = (accept: boolean, focus = true) => {
          if (finished || !alive()) return;
          finished = true;
          const value = input.value;
          content.replaceChildren();
          if (focus) editor.focus();
          ui.mode(currentMode);
          if (accept) submit(value);
        };
        input.addEventListener("keydown", event => {
          event.stopPropagation();
          if (event.isComposing) return;
          if (event.key === "Escape" || event.key === "Enter") {
            event.preventDefault();
            finish(event.key === "Enter");
          }
        });
        input.addEventListener("blur", () => finish(false, false));
        node.hidden = false;
        input.focus();
      },
    };
    const focus = editor.onDidFocusEditorWidget(publish);
    const blur = editor.onDidBlurEditorWidget(() => queueMicrotask(publish));
    const configuration = editor.onDidChangeConfiguration(syncInput);
    const root = editor.getDomNode();
    const guardInput = (event: Event) => {
      if (currentMode === "insert" && !editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.classList.contains("inputarea")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    root?.addEventListener("beforeinput", guardInput, true);
    // Keep application shortcuts on macOS (Command) and save on all platforms.
    // Other Ctrl keys belong to the modal engine while editor text has focus.
    const shortcut = editor.onKeyDown(event => {
      const key = event.browserEvent.key.toLowerCase();
      if (!editor.hasTextFocus()) return;
      if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        event.stopPropagation();
        command("write");
      } else if (keymap === "vim" && !controller) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    cleanup = () => {
      closing = true;
      shortcut.dispose();
      focus.dispose();
      blur.dispose();
      configuration.dispose();
      root?.removeEventListener("beforeinput", guardInput, true);
      controller?.dispose();
      editor.removeOverlayWidget(widget);
      node.remove();
      editor.pushUndoStop();
    };
    if (keymap === "helix") {
      controller = new HelixController(editor, ui);
    } else {
      // Prevent IME/beforeinput from inserting text while the Vim chunk loads.
      editor.updateOptions({ domReadOnly: true });
      notify("Loading Vim…");
      void import("monaco-vim").then(({ initVimMode, VimMode, StatusBar }) => {
        if (!alive()) return;
        configureVim(VimMode);
        message.textContent = "";
        content.replaceChildren();
        class LogosVimStatus extends StatusBar {
          constructor(target: HTMLElement) {
            // Upstream dispose calls closeInput, which normally steals focus.
            super(target, null);
            const close = this.closeInput;
            this.closeInput = () => { close(); if (!closing) editor.focus(); };
          }
        }
        const adapter = initVimMode(editor, content, LogosVimStatus);
        vimCommands.set(adapter, command);
        const onMode = (event: { mode: string; subMode?: string }) => {
          currentMode = event.subMode ? `${event.mode} ${event.subMode}` : event.mode;
          node.dataset.mode = currentMode;
          editor.updateOptions({ domReadOnly: editor.getOption(monaco.editor.EditorOption.readOnly) || event.mode !== "insert" });
          syncInput();
          publish();
        };
        adapter.on("vim-mode-change", onMode);
        adapter.on("vim-keypress", (key: string) => { pending += key; publish(); });
        adapter.on("vim-command-done", () => { pending = ""; publish(); });
        controller = { dispose: () => { vimCommands.delete(adapter); adapter.dispose(); } };
        onMode({ mode: "normal" });
      }).catch(error => notify(`Vim failed to load: ${error instanceof Error ? error.message : String(error)}`));
    }
    publish();
  };
  const settings = useStore.subscribe((state) => {
    const next = state.settings["workbench.keymap"];
    if (mode !== next) { mode = next; reset(); }
  });
  const model = editor.onDidChangeModel(reset);
  reset();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    settings();
    model.dispose();
    reset();
  };
  const lifetime = editor.onDidDispose(dispose);
  return { dispose: () => { lifetime.dispose(); dispose(); } };
}
