import { promises as fs } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

interface StoredAcpSecret {
  serverId: string;
  name: string;
  value: string;
}

interface AcpSecretFile {
  version: 1;
  secrets: Record<string, StoredAcpSecret>;
}

function isSecureStorageAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text")
  );
}

export class AcpSecretStore {
  private readonly file: string;
  private secrets: Record<string, StoredAcpSecret> | null = null;
  private loadPromise: Promise<Record<string, StoredAcpSecret>> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "credentials", "acp-env.enc");
  }

  async set(
    serverId: string,
    name: string,
    value: string,
    reference?: string,
  ): Promise<string> {
    if (!serverId || !name) throw new Error("ACP secret server and name are required");
    return this.mutate(async (secrets) => {
      const existing = reference ? secrets[reference] : undefined;
      const ref =
        existing?.serverId === serverId && existing.name === name
          ? reference!
          : `acp:${crypto.randomUUID()}`;
      const next = {
        ...secrets,
        [ref]: { serverId, name, value },
      };
      await this.persist(next);
      this.secrets = next;
      return ref;
    });
  }

  async delete(reference: string): Promise<void> {
    await this.mutate(async (secrets) => {
      if (!(reference in secrets)) return;
      const next = { ...secrets };
      delete next[reference];
      await this.persist(next);
      this.secrets = next;
    });
  }

  async resolve(
    serverId: string,
    references: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const secrets = await this.load();
    return Object.fromEntries(
      Object.entries(references).map(([name, reference]) => {
        const secret = secrets[reference];
        if (!secret || secret.serverId !== serverId || secret.name !== name) {
          throw new Error(`ACP secret is unavailable: ${name}`);
        }
        return [name, secret.value];
      }),
    );
  }

  async has(serverId: string, name: string, reference: string): Promise<boolean> {
    const secret = (await this.load())[reference];
    return Boolean(
      secret && secret.serverId === serverId && secret.name === name,
    );
  }

  private async load(): Promise<Record<string, StoredAcpSecret>> {
    if (this.secrets) return this.secrets;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (!isSecureStorageAvailable()) {
          throw new Error("OS secure storage is unavailable");
        }
        try {
          const encrypted = await fs.readFile(this.file);
          const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as AcpSecretFile;
          if (parsed.version !== 1 || !parsed.secrets) {
            throw new Error("Invalid ACP credential file");
          }
          this.secrets = parsed.secrets;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          this.secrets = {};
        }
        return this.secrets;
      })().finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private mutate<T>(
    operation: (secrets: Record<string, StoredAcpSecret>) => Promise<T>,
  ): Promise<T> {
    const result = this.mutationQueue.then(async () => operation(await this.load()));
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(secrets: Record<string, StoredAcpSecret>): Promise<void> {
    if (!isSecureStorageAvailable()) {
      throw new Error("OS secure storage is unavailable; credentials were not saved");
    }
    const encrypted = safeStorage.encryptString(
      JSON.stringify({ version: 1, secrets } satisfies AcpSecretFile),
    );
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, encrypted, { mode: 0o600 });
      await fs.rename(temp, this.file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
