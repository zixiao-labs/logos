import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@lightning-js/lightning";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CH } from "../../shared/channels";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { Settings } from "../../shared/types";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerSettingsService } from "./settings";
import type { AcpSecretStore } from "./acp-secrets";

describe("settings service", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-settings-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  function setup(acpSecrets?: AcpSecretStore) {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    const ctx = {
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: (channel: string, ...args: unknown[]) => sent.push([channel, ...args]),
    } satisfies ServiceContext;
    registerSettingsService(ctx, acpSecrets);
    return { ...ipc, sent };
  }

  it("returns defaults when the settings file is missing or corrupt", async () => {
    let service = setup();
    expect(await service.invoke<Settings>(CH.settingsGetAll)).toEqual(
      DEFAULT_SETTINGS,
    );

    await fs.writeFile(
      path.join(userDataDir, "settings.json"),
      "not-json",
      "utf8",
    );
    service = setup();
    expect(await service.invoke<Settings>(CH.settingsGetAll)).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it("merges persisted values with new defaults", async () => {
    await fs.writeFile(
      path.join(userDataDir, "settings.json"),
      JSON.stringify({ "editor.fontSize": 18 }),
      "utf8",
    );
    const service = setup();

    const settings = await service.invoke<Settings>(CH.settingsGetAll);
    expect(settings["editor.fontSize"]).toBe(18);
    expect(settings["workbench.theme"]).toBe(DEFAULT_SETTINGS["workbench.theme"]);
    expect(settings["agent.logosModel"]).toBe("gpt-5.6-sol");
  });

  it("persists patches, broadcasts changes, and resets to defaults", async () => {
    const service = setup();
    const updated = await service.invoke<Settings>(CH.settingsSet, {
      "workbench.theme": "light",
      "editor.tabSize": 4,
    } satisfies Partial<Settings>);

    expect(updated["workbench.theme"]).toBe("light");
    expect(updated["editor.tabSize"]).toBe(4);
    expect(service.sent.at(-1)?.[0]).toBe(CH.settingsChanged);

    const saved = JSON.parse(
      await fs.readFile(path.join(userDataDir, "settings.json"), "utf8"),
    ) as Settings;
    expect(saved["editor.tabSize"]).toBe(4);

    expect(await service.invoke<Settings>(CH.settingsReset)).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(await service.invoke<string>(CH.settingsGetPath)).toBe(
      path.join(userDataDir, "settings.json"),
    );
  });

  it("moves sensitive ACP environment values out of settings", async () => {
    const stored = new Map<string, string>();
    const acpSecrets = {
      async set(
        serverId: string,
        name: string,
        value: string,
        reference?: string,
      ) {
        const ref = reference ?? `secret:${serverId}:${name}`;
        stored.set(ref, value);
        return ref;
      },
      async delete(reference: string) {
        stored.delete(reference);
      },
      async has(_serverId: string, _name: string, reference: string) {
        return stored.has(reference);
      },
    } as AcpSecretStore;
    const service = setup(acpSecrets);
    const settings = await service.invoke<Settings>(CH.settingsSet, {
      "agent.acpServers": [
        {
          id: "custom",
          name: "Custom",
          command: "agent",
          args: [],
          env: { OPENAI_API_KEY: "secret-value", LOG_LEVEL: "debug" },
        },
      ],
    } satisfies Partial<Settings>);

    expect(settings["agent.acpServers"][0]).toMatchObject({
      env: { LOG_LEVEL: "debug" },
      secretEnv: { OPENAI_API_KEY: "secret:custom:OPENAI_API_KEY" },
    });
    expect(stored.get("secret:custom:OPENAI_API_KEY")).toBe("secret-value");
    const raw = await fs.readFile(path.join(userDataDir, "settings.json"), "utf8");
    expect(raw.includes("secret-value")).toBe(false);
  });

  it("manages ACP secrets without deleting referenced credentials", async () => {
    const stored = new Map<string, string>();
    const acpSecrets = {
      async set(
        serverId: string,
        name: string,
        value: string,
        reference?: string,
      ) {
        const ref = reference ?? `secret:${serverId}:${name}`;
        stored.set(ref, value);
        return ref;
      },
      async delete(reference: string) {
        stored.delete(reference);
      },
      async has(_serverId: string, _name: string, reference: string) {
        return stored.has(reference);
      },
    } as AcpSecretStore;
    const service = setup(acpSecrets);

    const reference = await service.invoke<string>(
      CH.settingsSetAcpSecret,
      "custom",
      "OPENAI_API_KEY",
      "secret-value",
    );
    expect(stored.get(reference)).toBe("secret-value");

    await service.invoke<Settings>(CH.settingsSet, {
      "agent.acpServers": [
        {
          id: "custom",
          name: "Custom",
          command: "agent",
          args: [],
          env: {},
          secretEnv: { OPENAI_API_KEY: reference },
        },
      ],
    } satisfies Partial<Settings>);
    await expect(
      service.invoke(CH.settingsDeleteAcpSecret, reference),
    ).rejects.toThrow("ACP secret is still referenced by settings");

    await service.invoke<Settings>(CH.settingsSet, { "agent.acpServers": [] });
    await service.invoke(CH.settingsDeleteAcpSecret, reference);
    expect(stored.has(reference)).toBe(false);
  });
});
