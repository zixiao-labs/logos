import { describe, expect, it } from "@lightning-js/lightning";
import { characterSelection, cursorOf, moveSelection, nextChar, previousChar, regexSelections, textObject, wordSelection } from "./helix-selection";

describe("Helix selections", () => {
  it("selects words including trailing space with w, and without it with e", () => {
    const text = "alpha beta.gamma";
    const start = characterSelection(text, 0);
    const w = wordSelection(text, start, "w", 1, false);
    expect(text.slice(w.anchor, w.head)).toBe("alpha ");
    const second = wordSelection(text, w, "w", 1, false);
    expect(text.slice(second.anchor, second.head)).toBe("beta");
    const e = wordSelection(text, start, "e", 1, false);
    expect(text.slice(e.anchor, e.head)).toBe("alpha");
    expect(wordSelection(text, characterSelection(text, 6), "b", 1, false).head).toBe(0);
  });

  it("extends selections across the anchor without losing a character", () => {
    const text = "abcde";
    const initial = characterSelection(text, 2);
    const backwards = moveSelection(text, initial, 0, true);
    expect(backwards).toEqual({ anchor: 3, head: 0 });
    expect(moveSelection(text, backwards, 4, true)).toEqual({ anchor: 2, head: 5 });
  });

  it("keeps surrogate pairs, combining marks, joined emoji and CRLF intact", () => {
    const text = "a👩‍💻é\r\n中";
    expect(nextChar(text, 1)).toBe(6);
    expect(previousChar(text, 6)).toBe(1);
    expect(nextChar(text, 6)).toBe(8);
    expect(nextChar(text, 8)).toBe(10);
    expect(cursorOf(text, { anchor: 1, head: 6 })).toBe(1);
    expect(characterSelection("", 20)).toEqual({ anchor: 0, head: 0 });
  });

  it("selects nested inner/around objects and ignores escaped quotes", () => {
    const text = 'call(one, (two)) "a\\"b"';
    expect(textObject(text, characterSelection(text, 12), "(", false)).toEqual({ anchor: 11, head: 14 });
    expect(textObject(text, characterSelection(text, 12), ")", true)).toEqual({ anchor: 10, head: 15 });
    const quoted = textObject(text, characterSelection(text, 19), '"', false)!;
    expect(text.slice(quoted.anchor, quoted.head)).toBe('a\\"b');
    expect(textObject("alpha beta", characterSelection("alpha beta", 2), "w", true)).toEqual({ anchor: 0, head: 6 });
  });

  it("creates multiple regex selections and splits without looping on empty matches", () => {
    const text = "foo, bar, foo";
    const all = [{ anchor: 0, head: text.length }];
    expect(regexSelections(text, all, "foo", false)).toEqual([{ anchor: 0, head: 3 }, { anchor: 10, head: 13 }]);
    expect(regexSelections(text, all, ", ", true)).toEqual([{ anchor: 0, head: 3 }, { anchor: 5, head: 8 }, { anchor: 10, head: 13 }]);
    expect(regexSelections(text, all, "(?=o)", false)).toEqual([
      { anchor: 1, head: 1 }, { anchor: 2, head: 2 },
      { anchor: 11, head: 11 }, { anchor: 12, head: 12 },
    ]);
    expect(() => regexSelections(text, all, "[", false)).toThrow();
  });

  for (const eol of ["\n", "\r\n"]) {
    it(`selects inner and around paragraphs with ${JSON.stringify(eol)} line endings`, () => {
      const paragraphs = [`first${eol}line`, "middle", "last"];
      const separator = eol + eol;
      const text = paragraphs.join(separator);
      let offset = 0;
      for (const [index, paragraph] of paragraphs.entries()) {
        const range = characterSelection(text, offset + 1);
        expect(textObject(text, range, "p", false)).toEqual({ anchor: offset, head: offset + paragraph.length });
        expect(textObject(text, range, "p", true)).toEqual({
          anchor: offset,
          head: offset + paragraph.length + (index < paragraphs.length - 1 ? separator.length : 0),
        });
        offset += paragraph.length + separator.length;
      }
      const blanks = `first${eol}${eol}${eol}last`;
      expect(textObject(blanks, characterSelection(blanks, blanks.length - 1), "p", false)).toEqual({
        anchor: blanks.length - 4, head: blanks.length,
      });
    });
  }
});
