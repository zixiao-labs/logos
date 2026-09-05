import * as monaco from "monaco-editor";
import {
  characterSelection, cursorOf, moveSelection, nextChar, previousChar,
  regexSelections, selectionBounds, textObject, wordSelection,
  type HelixSelection,
} from "./helix-selection";
import type { ModalUI } from "./modal-types";

type Mode = "normal" | "insert" | "select";
// Registers survive editor switches, just as they do in Helix.
const registers = new Map<string, string[]>();
let searchPattern = "";
interface InsertHistory {
  before: number;
  after: number;
  beforeSelections: HelixSelection[];
  afterSelections: HelixSelection[];
}
const insertHistory = new WeakMap<monaco.editor.ITextModel, InsertHistory[]>();

export class HelixController implements monaco.IDisposable {
  private mode: Mode = "normal";
  private pending = "";
  private count = "";
  private register = '"';
  private changingSelection = false;
  private disposed = false;
  private subscriptions: monaco.IDisposable[] = [];
  private desiredColumns: number[] = [];
  private insertMarks: monaco.editor.IEditorDecorationsCollection;
  private cursorDecorations: monaco.editor.IEditorDecorationsCollection;
  private insertEntry = "i";
  private insertChanged = false;
  private insertVersion = 0;
  private insertSelections: HelixSelection[] = [];
  private historyQueue = Promise.resolve();
  private lastInsert: { entry: string; texts: string[] } | null = null;
  private lastFind: { command: string; character: string } | null = null;
  private textCache: { model: monaco.editor.ITextModel; value: string } | undefined;

  constructor(private editor: monaco.editor.IStandaloneCodeEditor, private ui: ModalUI) {
    this.insertMarks = editor.createDecorationsCollection();
    this.cursorDecorations = editor.createDecorationsCollection();
    this.subscriptions.push(
      editor.onKeyDown(event => {
        // Monaco may already have consumed Escape to dismiss a widget. It must
        // still leave Insert/Select and cancel incomplete Helix commands.
        if ((event.browserEvent.defaultPrevented && event.browserEvent.key !== "Escape") || event.browserEvent.isComposing) return;
        if (!editor.hasTextFocus()) return;
        if (this.key(event.browserEvent)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }),
      editor.onDidChangeCursorSelection(() => {
        if (this.changingSelection) return;
        this.desiredColumns = [];
        if (this.mode !== "insert") this.normalize();
      }),
      editor.onDidChangeModelContent(() => {
        this.textCache = undefined;
        if (this.mode === "insert") this.insertChanged = true;
      }),
    );
    this.setMode("normal");
    this.normalize();
  }

  private get model() { return this.editor.getModel()!; }
  private get text() {
    const model = this.model;
    if (this.textCache?.model !== model) this.textCache = { model, value: model.getValue() };
    return this.textCache.value;
  }
  private get readOnly() { return this.editor.getOption(monaco.editor.EditorOption.readOnly); }

  private ranges(): HelixSelection[] {
    return (this.editor.getSelections() ?? []).map(selection => ({
      anchor: this.model.getOffsetAt(selection.getSelectionStart()),
      head: this.model.getOffsetAt(selection.getPosition()),
    }));
  }

  private select(ranges: HelixSelection[], reveal = true) {
    if (!ranges.length || this.disposed) return;
    this.changingSelection = true;
    this.editor.setSelections(ranges.map(range => monaco.Selection.fromPositions(
      this.model.getPositionAt(range.anchor), this.model.getPositionAt(range.head),
    )));
    this.changingSelection = false;
    this.renderCursors();
    if (reveal) this.editor.revealPositionInCenterIfOutsideViewport(
      this.model.getPositionAt(cursorOf(this.text, ranges[0])),
    );
  }

  private normalize() {
    if (!this.editor.getModel()) return;
    const text = this.text;
    this.select(this.ranges().map(range => range.anchor === range.head
      ? characterSelection(text, range.head) : range), false);
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.editor.updateOptions({
      cursorStyle: mode === "insert" ? "line" : "block",
      cursorBlinking: mode === "insert" ? "blink" : "solid",
      domReadOnly: this.readOnly || mode !== "insert",
    });
    this.editor.getDomNode()?.classList.toggle("logos-helix-command", mode !== "insert");
    this.renderCursors();
    this.status();
  }

  private renderCursors() {
    if (this.mode === "insert") { this.cursorDecorations.clear(); return; }
    const text = this.text;
    this.cursorDecorations.set(this.ranges().map(range => {
      const offset = cursorOf(text, range);
      const position = this.model.getPositionAt(offset);
      const atEnd = position.column === this.model.getLineMaxColumn(position.lineNumber);
      return {
        range: monaco.Range.fromPositions(position, this.model.getPositionAt(atEnd ? offset : nextChar(text, offset))),
        options: {
          description: "helix-block-cursor",
          ...(atEnd ? { before: { content: " ", inlineClassName: "logos-helix-cursor" } } : { inlineClassName: "logos-helix-cursor" }),
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    }));
  }

  private status() { this.ui.mode(this.mode, this.count + this.pending); }

  private writable() {
    if (!this.readOnly) return true;
    this.ui.notify("Read-only editor");
    return false;
  }

  private action(id: string) { this.editor.trigger("helix", id, {}); }

  private edit(edits: { start: number; end: number; text: string }[], group = true, selectInserted = false) {
    if (!this.writable() || !edits.length) return;
    if (group) this.editor.pushUndoStop();
    this.changingSelection = true;
    this.editor.executeEdits("helix", edits.map(edit => ({
      range: monaco.Range.fromPositions(this.model.getPositionAt(edit.start), this.model.getPositionAt(edit.end)),
      text: edit.text,
      forceMoveMarkers: true,
    })), inverse => inverse.map(edit => selectInserted
      ? monaco.Selection.fromPositions(edit.range.getStartPosition(), edit.range.getEndPosition())
      : monaco.Selection.fromPositions(edit.range.getEndPosition())));
    this.changingSelection = false;
    if (group) this.editor.pushUndoStop();
    if (this.mode !== "insert") this.normalize();
  }

  private replace(texts: string[], group = true) {
    this.edit(this.ranges().map((range, index) => {
      const [start, end] = selectionBounds(range);
      return { start, end, text: texts[index % texts.length] ?? "" };
    }), group, this.mode !== "insert");
  }

  private yank() {
    const texts = this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      return this.text.slice(start, end);
    });
    registers.set(this.register, texts);
    if (this.register === "+" || this.register === "*") {
      void navigator.clipboard.writeText(texts.join("\n")).catch(() => this.ui.notify("Clipboard is unavailable"));
    }
    this.register = '"';
    return texts;
  }

  private paste(before: boolean, replace = false, count = 1) {
    if (!this.writable()) return;
    const register = this.register;
    this.register = '"';
    const perform = (texts: string[]) => {
      if (this.disposed || !texts.length) return;
      if (replace) { this.replace(texts.map(text => text.repeat(count))); return; }
      const edits = this.ranges().map((range, index) => {
        const [start, end] = selectionBounds(range);
        const text = (texts[index % texts.length] ?? "").repeat(count);
        let point = before ? start : end;
        if (/\r?\n$/.test(text)) {
          const line = this.model.getPositionAt(before ? start : Math.max(start, previousChar(this.text, end))).lineNumber;
          point = before ? this.model.getOffsetAt({ lineNumber: line, column: 1 })
            : line < this.model.getLineCount() ? this.model.getOffsetAt({ lineNumber: line + 1, column: 1 }) : this.text.length;
          if (!before && line === this.model.getLineCount() && this.model.getLineContent(line)) {
            return { start: point, end: point, text: this.model.getEOL() + text.replace(/\r?\n$/, "") };
          }
        }
        return { start: point, end: point, text };
      });
      this.edit(edits, true, true);
    };
    if (register === "+" || register === "*") {
      // Capture the selection and document version so a delayed clipboard read
      // cannot paste into a different selection or a subsequently edited file.
      const version = this.model.getVersionId();
      const ranges = JSON.stringify(this.ranges());
      void navigator.clipboard.readText().then(text => {
        if (!this.disposed && this.model.getVersionId() === version && JSON.stringify(this.ranges()) === ranges) perform([text]);
      }).catch(() => this.ui.notify("Clipboard is unavailable"));
    } else perform(registers.get(register) ?? []);
  }

  private enterInsert(entry: string) {
    if (!this.writable()) return;
    this.editor.pushUndoStop();
    this.insertVersion = this.model.getAlternativeVersionId();
    this.insertSelections = this.ranges();
    this.insertEntry = entry;
    this.setMode("insert");
    if (entry === "c") { this.yank(); this.replace([""], false); }
    else if (entry === "o" || entry === "O") {
      const seen = new Set<number>();
      const edits = this.ranges().flatMap(range => {
        const [from, to] = selectionBounds(range);
        const line = this.model.getPositionAt(entry === "O" ? from : previousChar(this.text, to)).lineNumber;
        if (seen.has(line)) return [];
        seen.add(line);
        const content = this.model.getLineContent(line);
        const indent = content.match(/^\s*/)?.[0] ?? "";
        const point = this.model.getOffsetAt({ lineNumber: line, column: entry === "O" ? 1 : content.length + 1 });
        return [{ start: point, end: point, text: entry === "O" ? indent + this.model.getEOL() : this.model.getEOL() + indent }];
      });
      this.edit(edits, false);
      if (entry === "O") this.select(this.ranges().map(range => {
        const position = this.model.getPositionAt(range.head);
        const line = Math.max(1, position.lineNumber - 1);
        const offset = this.model.getOffsetAt({ lineNumber: line, column: this.model.getLineMaxColumn(line) });
        return { anchor: offset, head: offset };
      }));
    } else {
      this.select(this.ranges().map(range => {
        const [start, end] = selectionBounds(range);
        let offset = entry === "a" ? end : start;
        if (entry === "I" || entry === "A") {
          const line = this.model.getPositionAt(cursorOf(this.text, range)).lineNumber;
          offset = this.model.getOffsetAt({ lineNumber: line, column: entry === "I"
            ? this.model.getLineFirstNonWhitespaceColumn(line) || 1 : this.model.getLineMaxColumn(line) });
        }
        return { anchor: offset, head: offset };
      }));
    }
    this.insertChanged = entry === "c" || entry === "o" || entry === "O";
    this.insertMarks.set(this.ranges().map(range => ({
      range: monaco.Range.fromPositions(this.model.getPositionAt(range.head)),
      options: { description: "helix-insertion", stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    })));
  }

  private leaveInsert(record = true) {
    if (record && this.insertChanged) {
      this.lastInsert = { entry: this.insertEntry, texts: this.insertMarks.getRanges().map(range => this.model.getValueInRange(range)) };
    }
    this.insertMarks.clear();
    this.editor.pushUndoStop();
    const after = this.model.getAlternativeVersionId();
    this.setMode("normal");
    this.select(this.ranges().map(range => characterSelection(this.text,
      this.model.getPositionAt(range.head).column === 1 ? range.head : previousChar(this.text, range.head),
    )));
    if (after !== this.insertVersion) {
      const history = insertHistory.get(this.model) ?? [];
      history.push({ before: this.insertVersion, after, beforeSelections: this.insertSelections, afterSelections: this.ranges() });
      insertHistory.set(this.model, history.slice(-1000));
    }
    this.action("hideSuggestWidget");
  }

  private history(redo: boolean, count = 1) {
    if (!this.writable()) return;
    // Monaco inserts its own undo boundaries for whitespace, completion and
    // the first typed character after a change. A Helix insert session is one
    // modal history step, even when it spans several native undo elements.
    this.historyQueue = this.historyQueue.then(async () => {
      for (let n = 0; n < count && !this.disposed; n++) {
        if (this.readOnly) return;
        this.editor.pushUndoStop();
        const version = this.model.getAlternativeVersionId();
        const history = insertHistory.get(this.model) ?? [];
        const group = [...history].reverse().find(item => (redo ? item.before : item.after) === version);
        const target = group && (redo ? group.after : group.before);
        const visited = new Set<number>();
        do {
          const before = this.model.getAlternativeVersionId();
          if (visited.has(before)) break;
          visited.add(before);
          this.action(redo ? "redo" : "undo");
          await Promise.resolve();
          if (this.disposed) return;
          if (this.model.getAlternativeVersionId() === before) break;
        } while (target !== undefined && this.model.getAlternativeVersionId() !== target);
        if (group && this.model.getAlternativeVersionId() === target) {
          this.select(redo ? group.afterSelections : group.beforeSelections);
        }
        this.normalize();
      }
    });
  }

  private move(key: string, count: number) {
    const text = this.text;
    const extend = this.mode === "select";
    const vertical = ["j", "k", "ArrowDown", "ArrowUp"].includes(key);
    this.select(this.ranges().map((range, index) => {
      if (/^[wbeWBE]$/.test(key)) return wordSelection(text, range, key, count, extend);
      let offset = cursorOf(text, range);
      const position = this.model.getPositionAt(offset);
      if (vertical) {
        const column = this.desiredColumns[index] ?? position.column;
        this.desiredColumns[index] = column;
        const line = Math.max(1, Math.min(this.model.getLineCount(), position.lineNumber + (key === "j" || key === "ArrowDown" ? count : -count)));
        offset = this.model.getOffsetAt({ lineNumber: line, column: Math.min(column, this.model.getLineMaxColumn(line)) });
      } else if (key === "Home" || key === "End") {
        offset = this.model.getOffsetAt({ lineNumber: position.lineNumber, column: key === "Home" ? 1 : this.model.getLineMaxColumn(position.lineNumber) });
      } else {
        for (let n = 0; n < count; n++) offset = key === "h" || key === "ArrowLeft" ? previousChar(text, offset) : nextChar(text, offset);
      }
      return moveSelection(text, range, offset, extend);
    }));
    if (!vertical) this.desiredColumns = [];
  }

  private lines(extend: boolean, count: number) {
    this.select(this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      const first = this.model.getPositionAt(start).lineNumber;
      let last = this.model.getPositionAt(Math.max(start, previousChar(this.text, end))).lineNumber;
      const fullEnd = last < this.model.getLineCount() ? this.model.getOffsetAt({ lineNumber: last + 1, column: 1 }) : this.text.length;
      if (extend && start === this.model.getOffsetAt({ lineNumber: first, column: 1 }) && end === fullEnd) last++;
      last = Math.min(this.model.getLineCount(), last + count - 1);
      return { anchor: this.model.getOffsetAt({ lineNumber: first, column: 1 }), head: last < this.model.getLineCount()
        ? this.model.getOffsetAt({ lineNumber: last + 1, column: 1 }) : this.text.length };
    }));
  }

  private find(command: string, character: string, count: number) {
    this.lastFind = { command, character };
    const forward = command === command.toLowerCase();
    const till = command.toLowerCase() === "t";
    const text = this.text;
    this.select(this.ranges().map(range => {
      const origin = cursorOf(text, range);
      let offset = origin;
      for (let n = 0; n < count; n++) {
        const found = forward ? text.indexOf(character, nextChar(text, offset)) : offset > 0 ? text.lastIndexOf(character, previousChar(text, offset)) : -1;
        if (found < 0) return range;
        offset = found;
      }
      if (till) offset = forward ? previousChar(text, offset) : nextChar(text, offset);
      return moveSelection(text, this.mode === "select" ? range : characterSelection(text, origin), offset, true);
    }));
  }

  private search(backwards: boolean, count = 1) {
    if (!searchPattern) return;
    try {
      const matches = regexSelections(this.text, [{ anchor: 0, head: this.text.length }], searchPattern, false);
      if (!matches.length) { this.ui.notify("No matches"); return; }
      const ranges = this.ranges();
      const next = ranges.map(range => {
        const cursor = cursorOf(this.text, range);
        let index = matches.findIndex(match => match.anchor > cursor);
        if (backwards) {
          index = -1;
          for (let n = 0; n < matches.length && matches[n].anchor < cursor; n++) index = n;
        }
        if (index < 0) index = backwards ? matches.length - 1 : 0;
        index = ((index + (backwards ? -1 : 1) * (count - 1)) % matches.length + matches.length) % matches.length;
        return matches[index];
      });
      this.select(this.mode === "select" ? [...ranges, ...next] : next);
    } catch { this.ui.notify("Invalid regular expression"); }
  }

  private goto(key: string, count: number) {
    const actions: Record<string, string> = {
      d: "logos.lsp.goToDefinitionInMultibuffer", y: "logos.lsp.goToTypeDefinitionInMultibuffer",
      r: "logos.lsp.findReferencesInMultibuffer", i: "editor.action.goToImplementation",
    };
    if (actions[key]) { this.action(actions[key]); return; }
    if (!["g", "e", "h", "l", "s", "|"].includes(key)) return;
    this.select(this.ranges().map(range => {
      let { lineNumber, column } = this.model.getPositionAt(cursorOf(this.text, range));
      if (key === "g") { lineNumber = Math.min(count, this.model.getLineCount()); column = 1; }
      if (key === "e") { lineNumber = this.model.getLineCount(); column = 1; }
      if (key === "h") column = 1;
      if (key === "l") column = this.model.getLineMaxColumn(lineNumber);
      if (key === "s") column = this.model.getLineFirstNonWhitespaceColumn(lineNumber) || 1;
      if (key === "|") column = count;
      return moveSelection(this.text, range, this.model.getOffsetAt({ lineNumber, column }), this.mode === "select");
    }));
  }

  private regexPrompt(kind: string) {
    this.ui.prompt(kind, pattern => {
      try {
        if (kind === "s" || kind === "S") {
          const result = regexSelections(this.text, this.ranges(), pattern, kind === "S");
          if (result.length) this.select(result);
          else this.ui.notify("No matches");
        } else {
          const regex = new RegExp(pattern, "mu");
          const result = this.ranges().filter(range => {
            const [start, end] = selectionBounds(range);
            return regex.test(this.text.slice(start, end));
          });
          if (result.length) this.select(result);
          else this.ui.notify("No matches");
        }
      } catch { this.ui.notify("Invalid regular expression"); }
    });
  }

  private key(event: KeyboardEvent): boolean {
    const key = event.key;
    if (event.metaKey || (event.ctrlKey && event.altKey)) return false;
    if (key === "Escape" || (event.ctrlKey && key === "[")) {
      if (this.mode === "insert") this.leaveInsert();
      else this.setMode("normal");
      this.pending = this.count = "";
      this.register = '"';
      this.status();
      return true;
    }
    if (this.mode === "insert") return false;
    if (event.ctrlKey) {
      if (key.toLowerCase() === "z") { this.history(event.shiftKey); return true; }
      const actions: Record<string, string> = { b: "cursorPageUp", f: "cursorPageDown", c: "editor.action.commentLine" };
      if (key === "u" || key === "d") {
        this.move(key === "u" ? "k" : "j", Math.max(1, Math.floor(this.editor.getLayoutInfo().height / this.editor.getOption(monaco.editor.EditorOption.lineHeight) / 2)));
        return true;
      }
      if (actions[key]) {
        if (key !== "c" || this.writable()) this.action(actions[key]);
        return true;
      }
      return false;
    }
    if (event.altKey) {
      if (event.code === "Semicolon") this.select(this.ranges().map(range => ({ anchor: range.head, head: range.anchor })));
      else if (event.code === "KeyS") this.select(regexSelections(this.text, this.ranges(), "\\r?\\n", true));
      else if (event.code === "Period" && this.lastFind) this.find(this.lastFind.command, this.lastFind.character, 1);
      else return false;
      return true;
    }
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(key)) return false;
    if (/^F\d+$/.test(key) && this.pending !== "r" && this.pending !== "ms") return false;
    if (!this.pending && /^\d$/.test(key)) {
      this.count = String(Math.min(10000, Number(this.count + key)));
      this.status();
      return true;
    }
    const count = Math.max(1, Number(this.count) || 1);
    if (this.pending) {
      const prefix = this.pending;
      this.pending = "";
      if ((prefix === "r" || prefix === "ms") && !(prefix === "r" && key === "Enter") && (!key || nextChar(key, 0) !== key.length)) {
        this.count = "";
        this.status();
        return true;
      }
      if (prefix === "m" && (key === "i" || key === "a" || key === "s")) this.pending = "m" + key;
      else if (prefix === "g") this.goto(key, count);
      else if (prefix === '"') this.register = key;
      else if (/^[ftFT]$/.test(prefix)) this.find(prefix, key, count);
      else if (prefix === "r") {
        if (this.writable()) this.replace(this.ranges().map(range => {
          const [start, end] = selectionBounds(range);
          return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(this.text.slice(start, end)))
            .map(part => /\r?\n/.test(part.segment) ? part.segment : key === "Enter" ? this.model.getEOL() : key).join("");
        }));
      } else if (prefix === "mi" || prefix === "ma") {
        this.select(this.ranges().map(range => textObject(this.text, range, key, prefix === "ma") ?? range));
      } else if (prefix === "ms" && this.writable()) {
        const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[key] ?? key;
        this.replace(this.ranges().map(range => {
          const [start, end] = selectionBounds(range);
          return key + this.text.slice(start, end) + close;
        }));
      } else if (prefix === "m" && key === "m") this.action("editor.action.jumpToBracket");
      else if (prefix === " ") {
        if (key === "y") { this.register = "+"; this.yank(); }
        else if (key === "p" || key === "P") { this.register = "+"; this.paste(key === "P"); }
        else if (key === "k") this.action("editor.action.showHover");
        else if (key === "r" && this.writable()) this.action("editor.action.rename");
        else if (key === "a") this.action("editor.action.quickFix");
      }
      if (!this.pending) this.count = "";
      this.status();
      return true;
    }
    if (["g", "m", "f", "t", "F", "T", '"', "r", " "].includes(key)) {
      this.pending = key;
      this.status();
      return true;
    }
    this.count = "";
    if (["h", "j", "k", "l", "w", "e", "b", "W", "E", "B", "Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) this.move(key, count);
    else if (key === "v") this.setMode(this.mode === "select" ? "normal" : "select");
    else if (["i", "a", "I", "A", "o", "O", "c"].includes(key)) this.enterInsert(key);
    else if (key === "d") { if (this.writable()) { this.yank(); this.replace([""]); } }
    else if (key === "y") this.yank();
    else if (key === "p" || key === "P" || key === "R") this.paste(key === "P", key === "R", count);
    else if (key === "x" || key === "X") this.lines(key === "x", count);
    else if (key === "%") this.select([{ anchor: 0, head: this.text.length }]);
    else if (key === ";") this.select(this.ranges().map(range => characterSelection(this.text, cursorOf(this.text, range))));
    else if (key === ",") this.select(this.ranges().slice(0, 1));
    else if (key === "(" || key === ")") {
      const ranges = this.ranges();
      this.select(key === ")" ? [...ranges.slice(1), ranges[0]] : [ranges[ranges.length - 1], ...ranges.slice(0, -1)]);
    } else if (key === "C") {
      this.select([...this.ranges(), ...this.ranges().flatMap(range => {
        const [start, end] = selectionBounds(range);
        const a = this.model.getPositionAt(start);
        const b = this.model.getPositionAt(end);
        if (b.lineNumber >= this.model.getLineCount()) return [];
        return [{ anchor: this.model.getOffsetAt({ lineNumber: a.lineNumber + 1, column: a.column }), head: this.model.getOffsetAt({ lineNumber: b.lineNumber + 1, column: b.column }) }];
      })]);
    } else if (key === "u" || key === "U") {
      this.history(key === "U", count);
    } else if (key === "." && this.lastInsert && this.writable()) {
      const last = this.lastInsert;
      for (let n = 0; n < count; n++) {
        this.enterInsert(last.entry);
        this.replace(last.texts, false);
        this.leaveInsert(false);
      }
    } else if (key === "~" || key === "`") {
      if (this.writable()) this.replace(this.ranges().map(range => {
        const [start, end] = selectionBounds(range);
        return [...this.text.slice(start, end)].map(char => key === "`" ? char.toLowerCase() : char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join("");
      }));
    } else if (key === "_") {
      this.select(this.ranges().map(range => {
        const [start, end] = selectionBounds(range);
        const value = this.text.slice(start, end);
        if (!value.trim()) return range;
        return { anchor: start + value.length - value.trimStart().length, head: end - (value.length - value.trimEnd().length) };
      }));
    } else if (key === ">" || key === "<" || key === "=" || key === "J") {
      if (this.writable()) this.action(({ ">": "editor.action.indentLines", "<": "editor.action.outdentLines", "=": "editor.action.formatSelection", J: "editor.action.joinLines" })[key]!);
    } else if (key === "s" || key === "S" || key === "K") this.regexPrompt(key);
    else if (key === "/" || key === "?") this.ui.prompt(key, pattern => {
      if (pattern) searchPattern = pattern;
      this.search(key === "?", count);
    });
    else if (key === "n" || key === "N") this.search(key === "N", count);
    else if (key === "*") {
      const range = this.ranges()[0];
      const [start, end] = selectionBounds(range);
      searchPattern = this.text.slice(start, end).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (/\w/.test(this.text[start] ?? "") && !/\w/.test(this.text[start - 1] ?? "")) searchPattern = "\\b" + searchPattern;
      if (/\w/.test(this.text[end - 1] ?? "") && !/\w/.test(this.text[end] ?? "")) searchPattern += "\\b";
    } else if (key === ":") this.ui.prompt(":", value => this.ui.command(value));
    else if (key === "G") this.goto("g", count);
    else if (key === "PageUp" || key === "PageDown") this.action(key === "PageUp" ? "cursorPageUp" : "cursorPageDown");
    // In normal/select mode all unbound text keys are consumed. They must never
    // fall through to Monaco's insertion, delete, or tab handlers.
    this.status();
    return true;
  }

  dispose() {
    this.disposed = true;
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.insertMarks.clear();
    this.cursorDecorations.clear();
    this.editor.getDomNode()?.classList.remove("logos-helix-command");
    this.editor.pushUndoStop();
  }
}
