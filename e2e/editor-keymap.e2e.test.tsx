import { afterEach, beforeEach, describe, expect, it, vi } from "@lightning-js/lightning";
import * as monaco from "monaco-editor";
import { bindEditorKeymap, useEditorMode } from "../src/lib/editor-keymap";
import { useStore } from "../src/state/store";
import type { KeymapMode } from "../src/shared/types";
import { HelixController } from "../src/lib/helix";

// The test runner lives at a nested URL; workers are served at the server root.
self.MonacoEnvironment = { getWorkerUrl: () => "/monacoeditorwork/editorWorkerService.worker.js" };

describe("real Monaco modal editing", () => {
  let host: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor;
  let model: monaco.editor.ITextModel;
  let binding: monaco.IDisposable;
  let saves: number;
  let closes: number;
  let saveResult: boolean;

  async function mode(keymap: KeymapMode) {
    useStore.setState(state => ({ settings: { ...state.settings, "workbench.keymap": keymap } }));
    editor.focus();
    for (let n = 0; n < 200; n++) {
      if (keymap === "default" || host.querySelector(`.editor-modal-status[data-keymap="${keymap}"][data-mode="normal"]`)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Mode ${keymap} did not initialize: ${host.querySelector(".editor-modal-status")?.textContent}`);
  }

  // Dispatch through Monaco's actual DOM keyboard pipeline. Synthetic events
  // cannot perform browser default text insertion, so emulate only that default
  // after asserting that the modal handler left the event unconsumed.
  function key(value: string, options: KeyboardEventInit = {}) {
    const codes: Record<string, number> = { Escape: 27, Enter: 13, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ":": 186, ";": 186, "/": 191, "?": 191, ".": 190, ",": 188, '"': 222, " ": 32, "[": 219, "@": 50, "!": 49, "%": 53 };
    const event = new KeyboardEvent("keydown", {
      key: value, code: value.length === 1 && /[a-z]/i.test(value) ? `Key${value.toUpperCase()}` : value,
      keyCode: codes[value] ?? value.toUpperCase().charCodeAt(0),
      shiftKey: value.length === 1 && (value !== value.toLowerCase() || ':?"@!%'.includes(value)),
      bubbles: true, cancelable: true, ...options,
    });
    const target = host.querySelector<HTMLElement>(".inputarea, .native-edit-context, [role='textbox']")!;
    expect(target).not.toBeNull();
    target.dispatchEvent(event);
    if (!event.defaultPrevented && value.length === 1 && !options.ctrlKey && !options.metaKey && !options.altKey) {
      editor.trigger("keyboard", "type", { text: value });
    }
    target.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true }));
    return event;
  }

  function keys(value: string) { for (const char of value) key(char); }
  function selected() { return model.getValueInRange(editor.getSelection()!); }
  async function prompt(value: string) {
    const input = host.querySelector<HTMLInputElement>(".editor-modal-status input")!;
    expect(input).not.toBeNull();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  beforeEach(() => {
    saves = closes = 0;
    saveResult = true;
    useStore.setState(state => ({ settings: { ...state.settings, "workbench.keymap": "default" } }));
    host = document.createElement("div");
    host.style.cssText = "width:900px;height:500px;position:relative";
    document.body.append(host);
    model = monaco.editor.createModel("alpha beta\nsecond line\nthird", "plaintext");
    editor = monaco.editor.create(host, { model, automaticLayout: false, minimap: { enabled: false }, wordBasedSuggestions: "off" });
    binding = bindEditorKeymap(editor, {
      save: async () => { saves++; return saveResult; },
      close: async () => { closes++; return true; },
    });
    editor.focus();
  });

  afterEach(() => {
    binding.dispose();
    editor.dispose();
    model.dispose();
    host.remove();
  });

  it("Vim supports operators, counts, insert, undo and dot repeat", async () => {
    await mode("vim");
    keys("dw");
    expect(model.getValue()).toBe("beta\nsecond line\nthird");
    key("u");
    expect(model.getValue()).toBe("alpha beta\nsecond line\nthird");
    keys("ciw");
    expect(useEditorMode.getState().mode).toBe("insert");
    keys("hello");
    key("Escape");
    expect(model.getLineContent(1)).toBe("hello beta");
    keys("w.");
    expect(model.getLineContent(1)).toBe("hello hello");
    keys("gg2dd");
    expect(model.getValue()).toBe("third");
  });

  it("Vim supports visual selection, registers and macros", async () => {
    await mode("vim");
    keys('viwy');
    key("Escape");
    keys('A');
    key(" ");
    key("Escape");
    key("p");
    expect(model.getLineContent(1)).toBe("alpha beta alpha");
    keys("ggqaI");
    key("!");
    key("Escape");
    expect(model.getLineContent(1)).toBe("!alpha beta alpha");
    keys("qj");
    expect(editor.getPosition()?.lineNumber).toBe(2);
    keys("@a");
    expect(model.getLineContent(2)).toBe("!second line");
  });

  it("Vim searches and substitutes through its command line", async () => {
    await mode("vim");
    key("/");
    await prompt("second");
    expect(editor.getPosition()?.lineNumber).toBe(2);
    key(":");
    await prompt("%s/line/row/g");
    expect(model.getLineContent(2)).toBe("second row");
  });

  it("Helix selects before operating and groups change/insert into one undo", async () => {
    await mode("helix");
    key("e");
    expect(selected()).toBe("alpha");
    key("c");
    keys("hello");
    key("Escape");
    expect(model.getLineContent(1)).toBe("hello beta");
    key("u");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getLineContent(1)).toBe("alpha beta");
    key("U");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getLineContent(1)).toBe("hello beta");
  });

  it("Helix has extending selections, text objects and pending cancellation", async () => {
    await mode("helix");
    keys("v2l");
    expect(selected()).toBe("alp");
    key("Escape");
    keys("miw");
    expect(selected()).toBe("alpha");
    key("g");
    key("Escape");
    key("x");
    expect(selected()).toBe("alpha beta\n");
    key("x");
    expect(selected()).toBe("alpha beta\nsecond line\n");
    key("d");
    expect(model.getValue()).toBe("third");
  });

  it("Helix regex selection edits every match and repeats inserted text", async () => {
    model.setValue("foo bar foo");
    await mode("helix");
    keys("%s");
    await prompt("foo");
    expect(editor.getSelections()).toHaveLength(2);
    key("c");
    keys("baz");
    key("Escape");
    expect(model.getValue()).toBe("baz bar baz");
    key("u");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getValue()).toBe("foo bar foo");
    key(",");
    keys("miw.");
    expect(model.getValue()).toBe("baz bar foo");
  });

  it("Helix finds across lines and handles Unicode and CRLF atomically", async () => {
    model.setValue("👩‍💻é\r\n中");
    await mode("helix");
    expect(selected()).toBe("👩‍💻");
    key("d");
    expect(model.getValue()).toBe("é\r\n中");
    keys("f中");
    expect(selected()).toBe("é\r\n中");
  });

  it("Helix cancels replacement and surround commands on non-printable keys", async () => {
    await mode("helix");
    const before = model.getValue();
    for (const command of ["r", "ms"]) {
      for (const value of ["ArrowRight", "Backspace", "Delete", "Insert", "Home", "Dead", "F2"]) {
        keys("2" + command);
        key(value);
        expect(model.getValue()).toBe(before);
        expect(useEditorMode.getState().pending).toBe("");
      }
    }
    keys("rX");
    expect(model.getLineContent(1)).toBe("Xlpha beta");
    keys("ms(");
    expect(model.getLineContent(1)).toBe("(X)lpha beta");
  });

  it("Helix uses physical Alt shortcut keys and redoes with Ctrl+Shift+Z", async () => {
    model.setValue("one two two\nthree");
    await mode("helix");
    keys("ft");
    key("≥", { altKey: true, code: "Period", keyCode: 190 });
    expect(selected()).toBe("two t");
    const selection = editor.getSelection()!;
    key("…", { altKey: true, code: "Semicolon", keyCode: 186 });
    expect(editor.getSelection()!.getPosition()).toEqual(selection.getSelectionStart());
    key("%");
    key("ß", { altKey: true, code: "KeyS", keyCode: 83 });
    expect(editor.getSelections()).toHaveLength(2);
    key("d");
    const edited = model.getValue();
    key("z", { ctrlKey: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getValue()).toBe("one two two\nthree");
    key("Z", { ctrlKey: true, shiftKey: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getValue()).toBe(edited);
  });

  it("Helix caches text until content or the model changes", () => {
    const controller = new HelixController(editor, { mode() {}, notify() {}, command() {}, prompt() {} });
    const cached = controller as unknown as { readonly text: string };
    const getValue = vi.spyOn(model, "getValue");
    const other = monaco.editor.createModel("other");
    try {
      expect(cached.text).toBe("alpha beta\nsecond line\nthird");
      expect(cached.text).toBe("alpha beta\nsecond line\nthird");
      expect(getValue).not.toHaveBeenCalled();
      model.setValue("changed");
      expect(cached.text).toBe("changed");
      getValue.mockClear();
      expect(cached.text).toBe("changed");
      expect(getValue).not.toHaveBeenCalled();
      editor.setModel(other);
      expect(cached.text).toBe("other");
      model.setValue("detached edit");
      editor.setModel(model);
      expect(cached.text).toBe("detached edit");
    } finally {
      controller.dispose();
      getValue.mockRestore();
      editor.setModel(model);
      other.dispose();
    }
  });

  for (const keymap of ["vim", "helix"] as const) {
    it(`${keymap} gives modal Ctrl keys priority and saves once with an existing editor command`, async () => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saves++; });
      await mode(keymap);
      const pageDown = key("f", { ctrlKey: true });
      expect(pageDown.defaultPrevented).toBe(true);
      expect(editor.hasTextFocus()).toBe(true);
      key("s", /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(saves).toBe(1);
    });

    it(`${keymap} blocks IME input in Normal and restores it in Insert`, async () => {
      await mode(keymap);
      const input = () => host.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
      expect(input().readOnly).toBe(true);
      const composition = new InputEvent("beforeinput", {
        inputType: "insertCompositionText", data: "中文", isComposing: true, bubbles: true, cancelable: true,
      });
      input().dispatchEvent(composition);
      expect(composition.defaultPrevented).toBe(true);
      key("i");
      expect(input().readOnly).toBe(false);
      key("Escape");
      expect(input().readOnly).toBe(true);
    });

    it(`${keymap} saves and closes only after a successful write`, async () => {
      await mode(keymap);
      key(":");
      await prompt("wq");
      expect(saves).toBe(1);
      expect(closes).toBe(1);
      saveResult = false;
      key(":");
      await prompt("wq");
      expect(saves).toBe(2);
      expect(closes).toBe(1);
    });

    it(`${keymap} cannot mutate or undo a read-only model`, async () => {
      editor.executeEdits("test", [{ range: new monaco.Range(1, 1, 1, 1), text: "kept " }]);
      editor.pushUndoStop();
      editor.updateOptions({ readOnly: true });
      await mode(keymap);
      const before = model.getValue();
      keys("ddxp");
      key("u");
      key("r", { ctrlKey: true });
      key(":");
      await prompt(keymap === "vim" ? "undo" : "w");
      expect(model.getValue()).toBe(before);
      expect(saves).toBe(0);
    });
  }

  it("switches modes live, resets on model changes and restores default editing", async () => {
    await mode("vim");
    key("i");
    await mode("helix");
    expect(selected()).toBe("a");
    key("m");
    const other = monaco.editor.createModel("other");
    editor.setModel(other);
    expect(useEditorMode.getState().mode).toBe("normal");
    key("e");
    expect(other.getValueInRange(editor.getSelection()!)).toBe("other");
    await mode("default");
    expect(editor.getOption(monaco.editor.EditorOption.domReadOnly)).toBe(false);
    key("Z");
    expect(other.getValue()).toBe("Z");
    editor.setModel(model);
    other.dispose();
  });

  it("Helix preserves selections across undo/redo and opens indented lines", async () => {
    model.setValue("  one\n  two");
    await mode("helix");
    keys("gsmiwc");
    keys("new word");
    key("Escape");
    expect(selected()).toBe("d");
    key("u");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getValue()).toBe("  one\n  two");
    expect(selected()).toBe("one");
    key("U");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getValue()).toBe("  new word\n  two");
    expect(selected()).toBe("d");
    key("o");
    keys("below");
    key("Escape");
    expect(model.getValue()).toBe("  new word\n  below\n  two");
    key("u");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.getValue()).toBe("  new word\n  two");
  });

  it("Helix keeps transformed selections and supports zero-width regex cursors", async () => {
    model.setValue("one\ntwo");
    await mode("helix");
    keys("e~");
    expect(selected()).toBe("ONE");
    key("~");
    expect(selected()).toBe("one");
    keys("%s");
    await prompt("^");
    expect(editor.getSelections()).toHaveLength(2);
    key("i");
    key("!");
    key("Escape");
    expect(model.getValue()).toBe("!one\n!two");
  });

  it("disposal preserves focus outside the editor and removes modal listeners", async () => {
    await mode("vim");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    binding.dispose();
    expect(document.activeElement).toBe(input);
    expect(host.querySelector(".editor-modal-status")).toBeNull();
    expect(editor.getOption(monaco.editor.EditorOption.cursorStyle)).toBe(monaco.editor.TextEditorCursorStyle.Line);
    input.remove();
  });
});
