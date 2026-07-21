import { describe, expect, it } from "@lightning-js/lightning";
import {
  normalizeExternalUrl,
  workbenchContentSecurityPolicy,
} from "./workbench-security";

describe("workbench browser security", () => {
  it("builds a closed production CSP and a scoped development connection policy", () => {
    expect(workbenchContentSecurityPolicy()).toContain("connect-src 'none'");
    expect(workbenchContentSecurityPolicy()).toContain("object-src 'none'");
    expect(workbenchContentSecurityPolicy("http://127.0.0.1:5173")).toContain(
      "ws://127.0.0.1:5173",
    );
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
