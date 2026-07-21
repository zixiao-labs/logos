import { describe, expect, it } from "@lightning-js/lightning";
import { CH } from "../../shared/channels";
import { createIpcHarness } from "../../test/ipc-harness";
import { createSecureIpcMain } from "./ipc-security";

describe("secure IPC registration", () => {
  it("validates trusted senders and exact per-channel payloads", async () => {
    const raw = createIpcHarness();
    const secure = createSecureIpcMain(raw.ipcMain, {
      isTrustedSender: () => true,
    });
    secure.handle(CH.appPlatform, () => "darwin");

    expect(await raw.invoke(CH.appPlatform)).toBe("darwin");
    await expect(raw.invoke(CH.appPlatform, "unexpected")).rejects.toThrow(
      "Invalid IPC payload",
    );
  });

  it("fails closed for untrusted frames, oversized messages, and floods", async () => {
    const untrustedRaw = createIpcHarness();
    const untrusted = createSecureIpcMain(untrustedRaw.ipcMain, {
      isTrustedSender: () => false,
    });
    untrusted.handle(CH.appPlatform, () => "darwin");
    await expect(untrustedRaw.invoke(CH.appPlatform)).rejects.toThrow("main frame");

    const limitedRaw = createIpcHarness();
    const limited = createSecureIpcMain(limitedRaw.ipcMain, {
      isTrustedSender: () => true,
      maxMessageBytes: 64,
    });
    limited.handle(CH.appOpenExternal, () => undefined);
    await expect(
      limitedRaw.invoke(CH.appOpenExternal, `https://example.com/${"x".repeat(128)}`),
    ).rejects.toThrow("byte limit");

    const floodedRaw = createIpcHarness();
    const flooded = createSecureIpcMain(floodedRaw.ipcMain, {
      isTrustedSender: () => true,
      maxRequests: 1,
    });
    flooded.handle(CH.appPlatform, () => "darwin");
    expect(await floodedRaw.invoke(CH.appPlatform)).toBe("darwin");
    await expect(
      floodedRaw.invoke(CH.appPlatform),
    ).rejects.toThrow("rate limit");
  });

  it("refuses handlers without a declared security policy", () => {
    const raw = createIpcHarness();
    const secure = createSecureIpcMain(raw.ipcMain, {
      isTrustedSender: () => true,
    });
    expect(() => secure.handle("dynamic:method", () => undefined)).toThrow(
      "No IPC security policy",
    );
  });

  it("accepts declared optional values and bounded editor buffers", async () => {
    const raw = createIpcHarness();
    const secure = createSecureIpcMain(raw.ipcMain, {
      isTrustedSender: () => true,
    });
    secure.handle(CH.dialogSaveFile, () => undefined);
    secure.handle(CH.fsWriteFile, (_event, _path, content) =>
      (content as string).length,
    );

    expect(await raw.invoke(CH.dialogSaveFile, undefined)).toBeUndefined();
    expect(
      await raw.invoke(
        CH.fsWriteFile,
        "/workspace/large.txt",
        "x".repeat(512 * 1024),
      ),
    ).toBe(512 * 1024);
  });
});
