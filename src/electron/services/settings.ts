import { promises as fs } from "node:fs";
import path from "node:path";
import { CH } from "../../shared/channels";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { isSensitiveEnvName } from "../../shared/acp-env";
import type { AcpAgentConfig, Settings } from "../../shared/types";
import type { ServiceContext } from "./context";
import type { AcpSecretStore } from "./acp-secrets";

export function registerSettingsService(
  ctx: ServiceContext,
  acpSecrets?: AcpSecretStore,
): () => void {
  const { ipcMain } = ctx;
  const file = path.join(ctx.userDataDir, "settings.json");
  let current: Settings = { ...DEFAULT_SETTINGS };
  let loaded = false;
  let mutationQueue: Promise<void> = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function sanitizeAcpServers(
    servers: AcpAgentConfig[],
  ): Promise<{ servers: AcpAgentConfig[]; changed: boolean }> {
    if (!acpSecrets) return { servers, changed: false };
    let changed = false;
    const sanitized: AcpAgentConfig[] = [];
    for (const server of servers) {
      const env: Record<string, string> = {};
      const secretEnv = { ...(server.secretEnv ?? {}) };
      for (const [name, reference] of Object.entries(secretEnv)) {
        if (!(await acpSecrets.has(server.id, name, reference))) {
          throw new Error(`ACP secret reference is invalid: ${server.id}/${name}`);
        }
      }
      for (const [name, value] of Object.entries(server.env ?? {})) {
        if (!isSensitiveEnvName(name)) {
          env[name] = value;
          continue;
        }
        secretEnv[name] = await acpSecrets.set(
          server.id,
          name,
          value,
          secretEnv[name],
        );
        changed = true;
      }
      sanitized.push({
        ...server,
        env,
        ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
      });
    }
    return { servers: sanitized, changed };
  }

  async function writeSettings(settings: Settings): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(settings, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async function load(): Promise<Settings> {
    if (loaded) return current;
    try {
      const raw = await fs.readFile(file, "utf8");
      current = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      current = { ...DEFAULT_SETTINGS };
    }
    const normalized = await sanitizeAcpServers(current["agent.acpServers"]);
    if (normalized.changed) {
      current = { ...current, "agent.acpServers": normalized.servers };
      await writeSettings(current);
    }
    loaded = true;
    return current;
  }

  async function persist(next: Settings): Promise<Settings> {
    await writeSettings(next);
    current = next;
    loaded = true;
    ctx.send(CH.settingsChanged, next);
    return next;
  }

  ipcMain.handle(CH.settingsGetAll, () => mutate(load));

  ipcMain.handle(
    CH.settingsSet,
    (_e, patch: Partial<Settings>): Promise<Settings> =>
      mutate(async () => {
        await load();
        const next = { ...current, ...patch };
        const normalized = await sanitizeAcpServers(next["agent.acpServers"]);
        return persist({ ...next, "agent.acpServers": normalized.servers });
      }),
  );

  ipcMain.handle(CH.settingsReset, (): Promise<Settings> =>
    mutate(() => persist({ ...DEFAULT_SETTINGS })),
  );

  ipcMain.handle(CH.settingsGetPath, () => file);

  ipcMain.handle(
    CH.settingsSetAcpSecret,
    (
      _event,
      serverId: string,
      name: string,
      value: string,
      reference?: string,
    ) => {
      if (!acpSecrets) throw new Error("ACP secret storage is unavailable");
      return acpSecrets.set(serverId, name, value, reference);
    },
  );

  ipcMain.handle(CH.settingsDeleteAcpSecret, (_event, reference: string) =>
    mutate(async () => {
      if (!acpSecrets) throw new Error("ACP secret storage is unavailable");
      await load();
      if (
        current["agent.acpServers"].some((server) =>
          Object.values(server.secretEnv ?? {}).includes(reference),
        )
      ) {
        throw new Error("ACP secret is still referenced by settings");
      }
      return acpSecrets.delete(reference);
    }),
  );

  return () => undefined;
}
