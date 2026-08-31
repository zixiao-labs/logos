import { describe, expect, it } from "@lightning-js/lightning";
import { stripAnsiControlSequences } from "./ansi";

describe("debug console ANSI output", () => {
  it("removes the nested colors and emphasis in development server output", () => {
    const output =
      "  \x1b[36m\x1b[1mNASTI\x1b[22m\x1b[39m  \x1b[36mv2.2.0\x1b[39m  \x1b[2mready in \x1b[22m\x1b[1m24\x1b[22m \x1b[2mms\x1b[22m\n" +
      "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:  \x1b[36mhttp://localhost:\x1b[1m3000\x1b[22m/\x1b[39m\n";

    expect(stripAnsiControlSequences(output)).toBe(
      "  NASTI  v2.2.0  ready in 24 ms\n  ➜  Local:  http://localhost:3000/\n",
    );
  });

  it("removes extended colors and cursor controls", () => {
    expect(
      stripAnsiControlSequences(
        "\x1b[?25l\x1b[2K\x1b[1G\x1b[38;2;255;128;0mRGB\x1b[0m " +
          "\x1b[48;5;200mindexed\x1b[m \x1b[38:2::1:2:3mcolon\x1b[0m\x1b[?25h",
      ),
    ).toBe("RGB indexed colon");
  });

  it("removes OSC hyperlinks and titles with BEL or ST terminators", () => {
    for (const terminator of ["\x07", "\x1b\\", "\x9c"]) {
      expect(
        stripAnsiControlSequences(
          `\x1b]0;Development server${terminator}` +
            `\x1b]8;;http://localhost:3000/${terminator}Local\x1b]8;;${terminator}\n`,
        ),
      ).toBe("Local\n");
    }
  });

  it("handles single-byte CSI and OSC introducers and legacy escapes", () => {
    expect(
      stripAnsiControlSequences(
        "\x9b31merror\x9b0m \x9d8;;https://example.com\x9clink\x9d8;;\x9c\x1b(B\x1b7\x1b8",
      ),
    ).toBe("error link");
  });

  it("preserves Unicode, whitespace, markup and literal bracketed text", () => {
    const output =
      "[nasti] 已连接 🚀\r\n\t[36m is literal text\r[1, 2] <script> & \\u001b[0m\n\n";
    expect(stripAnsiControlSequences(output)).toBe(output);
    expect(stripAnsiControlSequences("")).toBe("");
  });

  it("removes control-only output consistently across calls", () => {
    for (let index = 0; index < 2; index++) {
      expect(stripAnsiControlSequences("\x1b[0m\x1b[2J\x1b[H")).toBe("");
    }
  });
});
