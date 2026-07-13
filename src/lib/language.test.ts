import { describe, expect, it } from "@lightning-js/lightning";
import {
  basename,
  dirname,
  languageFromPath,
  serverIdForLanguage,
} from "./language";

describe("languageFromPath", () => {
  it("recognizes filenames and case-insensitive extensions", () => {
    expect(languageFromPath("/workspace/Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("C:\\workspace\\INDEX.TSX")).toBe("typescript");
    expect(languageFromPath("component.vue")).toBe("html");
    expect(languageFromPath("script.zsh")).toBe("shell");
  });

  it("falls back to plaintext for dotfiles and unknown extensions", () => {
    expect(languageFromPath(".gitignore")).toBe("plaintext");
    expect(languageFromPath("README.unknown")).toBe("plaintext");
    expect(languageFromPath("LICENSE")).toBe("plaintext");
  });
});

describe("path helpers", () => {
  it("handles POSIX and Windows separators", () => {
    expect(basename("/workspace/src/main.ts")).toBe("main.ts");
    expect(basename("C:\\workspace\\src\\main.ts")).toBe("main.ts");
    expect(dirname("/workspace/src/main.ts")).toBe("/workspace/src");
    expect(dirname("C:\\workspace\\src\\main.ts")).toBe(
      "C:/workspace/src",
    );
  });
});

describe("serverIdForLanguage", () => {
  it("maps supported language families and rejects unsupported languages", () => {
    expect(serverIdForLanguage("javascript")).toBe("typescript");
    expect(serverIdForLanguage("scss")).toBe("css");
    expect(serverIdForLanguage("rust")).toBe("rust-analyzer");
    expect(serverIdForLanguage("markdown")).toBeNull();
  });
});
