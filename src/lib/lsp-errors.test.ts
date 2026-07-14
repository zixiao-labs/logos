import { describe, expect, it } from "@lightning-js/lightning";
import { isLspRequestCancelled } from "./lsp-errors";

describe("LSP errors", () => {
  it("recognizes only the LSP request-cancelled error code", () => {
    expect(isLspRequestCancelled({ code: -32800 })).toBe(true);
    expect(isLspRequestCancelled({ code: -32801 })).toBe(false);
    expect(isLspRequestCancelled(new Error("canceled by client"))).toBe(false);
    expect(isLspRequestCancelled(null)).toBe(false);
  });
});
