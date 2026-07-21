import { describe, expect, it } from "@lightning-js/lightning";
import {
  inlineScriptCspSources,
  normalizeExternalUrl,
  workbenchContentSecurityPolicy,
} from "./workbench-security";

describe("workbench browser security", () => {
  it("builds a closed production CSP and a scoped development connection policy", () => {
    const production = workbenchContentSecurityPolicy(undefined, [
      "'sha256-kN/PwaYvV6S4Ck7rWfW2gkQ2p3Q0aZqL8bmMQZV5m0k='",
    ]);
    expect(production).toContain("connect-src 'none'");
    expect(production).toContain("object-src 'none'");
    expect(production).toContain(
      "script-src 'self' 'sha256-kN/PwaYvV6S4Ck7rWfW2gkQ2p3Q0aZqL8bmMQZV5m0k='",
    );
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");

    const development = workbenchContentSecurityPolicy(
      "http://127.0.0.1:5173",
    );
    expect(development).toContain("ws://127.0.0.1:5173");
    expect(development).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("derives production CSP hashes from emitted inline scripts", () => {
    const sources = inlineScriptCspSources(
      '<script>window.ready = true;</script><script src="./main.js"></script>',
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
  });

  it("normalizes HTTPS and mail links while rejecting local and insecure schemes", () => {
    expect(normalizeExternalUrl("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeExternalUrl("mailto:security@example.com")).toBe(
      "mailto:security@example.com",
    );
    for (const candidate of [
      "http://example.com",
      "file:///tmp/secret",
      "https://user:password@example.com",
      "https://example.com\nfile:///tmp/secret",
    ]) {
      expect(() => normalizeExternalUrl(candidate)).toThrow();
    }
  });
});
