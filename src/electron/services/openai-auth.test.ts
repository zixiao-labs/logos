import { afterEach, beforeEach, describe, expect, it } from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAIAuthStore } from "./openai-auth";

function testStorage(onDecrypt?: () => void) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => {
      onDecrypt?.();
      return value.toString("utf8");
    },
  };
}

describe("OpenAI auth store", () => {
  let root: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openai-auth-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("shares concurrent loads and retries after a load failure", async () => {
    const file = path.join(root, "credentials", "openai.enc");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ type: "api-key", apiKey: "test-key" }));
    let decrypts = 0;
    let fail = true;
    const storage = testStorage(() => {
      decrypts += 1;
      if (fail) throw new Error("decrypt failed");
    });
    const store = new OpenAIAuthStore(root, async () => undefined, storage);

    await expect(Promise.all([store.status(), store.status()])).rejects.toThrow(
      "decrypt failed",
    );
    fail = false;

    await expect(store.status()).resolves.toMatchObject({ type: "api-key" });
    expect(decrypts).toBe(2);
  });

  it("does not commit a stale refresh after a newer key or logout", async () => {
    for (const replacement of ["api-key", "logout"] as const) {
      const userDataDir = path.join(root, replacement);
      const file = path.join(userDataDir, "credentials", "openai.enc");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify({
          type: "chatgpt",
          accessToken: "expired-access",
          refreshToken: "refresh-token",
          expiresAt: 0,
        }),
      );
      const store = new OpenAIAuthStore(
        userDataDir,
        async () => undefined,
        testStorage(),
      );
      let releaseExchange: (() => void) | undefined;
      let exchangeStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        exchangeStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
      globalThis.fetch = (async () => {
        exchangeStarted?.();
        await release;
        return new Response(
          JSON.stringify({
            access_token: "stale-access",
            refresh_token: "stale-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof globalThis.fetch;

      const request = store.requestAuth("https://api.openai.test/v1");
      await started;
      if (replacement === "api-key") await store.setApiKey("new-key");
      else await store.logout();
      releaseExchange?.();

      await expect(request).rejects.toThrow(
        "OpenAI credentials changed while the token was refreshing",
      );
      if (replacement === "api-key") {
        await expect(store.status()).resolves.toMatchObject({ type: "api-key" });
        const saved = JSON.parse(await fs.readFile(file, "utf8")) as {
          type: string;
          apiKey?: string;
        };
        expect(saved).toEqual({ type: "api-key", apiKey: "new-key" });
      } else {
        await expect(store.status()).resolves.toEqual({ type: "none" });
        expect(await fs.stat(file).catch(() => null)).toBeNull();
      }
      expect(
        (await fs.readdir(path.dirname(file))).some((name) => name.endsWith(".tmp")),
      ).toBe(false);
    }
  });
});
