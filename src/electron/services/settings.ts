import { promises as fs } from "node:fs";
import path from "node:path";
import { CH } from "../../shared/channels";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { Settings } from "../../shared/types";
import type { ServiceContext } from "./context";

export function registerSettingsService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const file = path.join(ctx.userDataDir, "settings.json");
  let current: Settings = { ...DEFAULT_SETTINGS };
  let loaded = false;

  async function load(): Promise<Settings> {
    if (loaded) return current;
    try {
      const raw = await fs.readFile(file, "utf8");
      current = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      current = { ...DEFAULT_SETTINGS };
    }
    loaded = true;
    return current;
  }

  async function persist(): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(current, null, 2), "utf8");
    ctx.send(CH.settingsChanged, current);
  }

  ipcMain.handle(CH.settingsGetAll, () => load());

  ipcMain.handle(
    CH.settingsSet,
    async (_e, patch: Partial<Settings>): Promise<Settings> => {
      await load();
      current = { ...current, ...patch };
      await persist();
      return current;
    },
  );

  ipcMain.handle(CH.settingsReset, async (): Promise<Settings> => {
    current = { ...DEFAULT_SETTINGS };
    await persist();
    return current;
  });

  ipcMain.handle(CH.settingsGetPath, () => file);

  return () => undefined;
}
