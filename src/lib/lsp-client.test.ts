import { describe, expect, it } from "@lightning-js/lightning";
import type { Settings } from "../shared/types";
import {
  matchesLspDocumentSelector,
  matchesLspGlob,
  resolveLspConfiguration,
} from "./lsp-client";

const settings = {
  "editor.tabSize": 2,
  "python.analysis.typeCheckingMode": "strict",
  "python.analysis.diagnosticMode": "workspace",
  "agent.apiKey": "secret",
} as unknown as Settings;

describe("resolveLspConfiguration", () => {
  it("preserves item order and resolves exact values", () => {
    expect(
      resolveLspConfiguration(settings, [
        { section: "editor.tabSize" },
        { section: "missing" },
      ]),
    ).toEqual([2, null]);
  });

  it("builds nested objects from dotted settings", () => {
    expect(resolveLspConfiguration(settings, [{ section: "python" }])).toEqual([
      {
        analysis: {
          typeCheckingMode: "strict",
          diagnosticMode: "workspace",
        },
      },
    ]);
  });

  it("never exposes stored authentication secrets", () => {
    expect(resolveLspConfiguration(settings, [{ section: "agent.apiKey" }])).toEqual([
      null,
    ]);
    expect(resolveLspConfiguration(settings, [{}])[0]).not.toHaveProperty(
      "agent.apiKey",
    );
  });
});

describe("matchesLspDocumentSelector", () => {
  it("matches language, scheme and brace globs", () => {
    const options = {
      documentSelector: [
        { language: "typescript", scheme: "file", pattern: "**/*.{ts,tsx}" },
      ],
    };
    expect(
      matchesLspDocumentSelector(options, "typescript", {
        scheme: "file",
        path: "/project/src/app.ts",
      }),
    ).toBe(true);
    expect(
      matchesLspDocumentSelector(options, "javascript", {
        scheme: "file",
        path: "/project/src/app.ts",
      }),
    ).toBe(false);
  });
});

describe("matchesLspGlob", () => {
  it("supports recursive, single-segment and case-insensitive patterns", () => {
    expect(matchesLspGlob("**/*.ts", "/project/src/app.ts")).toBe(true);
    expect(matchesLspGlob("**/*.ts", "app.ts")).toBe(true);
    expect(matchesLspGlob("{src,test}/**/*.{ts,js}", "src/app.ts")).toBe(true);
    expect(matchesLspGlob("**/?.TS", "/project/src/a.ts", true)).toBe(true);
    expect(matchesLspGlob("**/*.ts", "/project/src/app.js")).toBe(false);
  });
});
