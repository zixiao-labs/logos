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
import type { AcpRegistryAgent } from "../../shared/types";
import { createIpcHarness } from "../../test/ipc-harness";
import {
  ACP_REGISTRY_CACHE_FILE,
  currentAcpPlatform,
  normalizeSafeArchivePath,
  normalizeSafeCommandPath,
  parseAcpRegistry,
  projectAcpRegistryAgents,
  registerAcpRegistryService,
  resolveAcpRegistryAgent,
} from "./acp-registry";
import type { ServiceContext } from "./context";

function registryAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "example",
    name: "Example Agent",
    version: "1.2.3",
    description: "An ACP agent",
    distribution: {
      npx: {
        package: "@example/agent@1.2.3",
        args: ["--acp", "two words"],
        env: { MANIFEST_ONLY: "yes" },
      },
    },
    ...overrides,
  };
}

describe("ACP registry parsing and resolution", () => {
  it("filters malformed agents and distributions while tolerating extensions", () => {
    const registry = parseAcpRegistry({
      version: "1.0.0",
      extensions: [{ future: true }],
      unknownTopLevelField: true,
      agents: [
        registryAgent(),
        registryAgent({ id: "example" }),
        registryAgent({ id: "../escape" }),
        registryAgent({ id: "missing-distribution", distribution: { npx: { package: 42 } } }),
        registryAgent({
          id: "binary-fallback",
          distribution: {
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/agent.tar.gz",
                cmd: "../../escape",
              },
            },
            uvx: { package: "example-agent==1.2.3" },
          },
        }),
      ],
    });

    expect(registry.agents.map((agent) => agent.id)).toEqual([
      "example",
      "binary-fallback",
    ]);
    expect(registry.agents[1]?.distribution.binary).toBeUndefined();
    expect(registry.agents[1]?.distribution.uvx?.package).toBe("example-agent==1.2.3");
  });

  it("rejects binary entries without SHA-256 while preserving package fallback", () => {
    const registry = parseAcpRegistry({
      agents: [
        registryAgent({
          distribution: {
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/agent.tar.gz",
                cmd: "bin/agent",
              },
            },
            npx: { package: "example@1.2.3" },
          },
        }),
      ],
    });

    expect(registry.agents[0]?.distribution.binary).toBeUndefined();
    expect(registry.agents[0]?.distribution.npx?.package).toBe("example@1.2.3");
  });

  it("resolves npx as a pinned, argument-safe launch with manifest env only", async () => {
    const agent = parseAcpRegistry({ agents: [registryAgent()] }).agents[0]!;
    const config = await resolveAcpRegistryAgent(agent, {
      platform: "linux-aarch64",
      runtimePlatform: "win32",
    });

    expect(config).toEqual({
      id: "registry:example",
      name: "Example Agent",
      command: "npx.cmd",
      args: ["--yes", "@example/agent@1.2.3", "--acp", "two words"],
      env: { MANIFEST_ONLY: "yes" },
      authArgsPrefix: ["--yes", "@example/agent@1.2.3"],
    });
  });

  it("projects exact binary platform availability and prefers that binary", async () => {
    const agent = parseAcpRegistry({
      agents: [
        registryAgent({
          distribution: {
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/agent.tgz",
                cmd: "./bin/agent",
                args: ["serve"],
                sha256: "a".repeat(64),
              },
            },
            npx: { package: "example@1.2.3" },
          },
        }),
      ],
    });

    expect(projectAcpRegistryAgents(agent, "linux-x86_64")[0]).toMatchObject({
      distributionKinds: ["binary", "npx"],
      available: true,
    });
    const binaryOnly = {
      ...agent,
      agents: [
        {
          ...agent.agents[0]!,
          distribution: { binary: agent.agents[0]!.distribution.binary },
        },
      ],
    };
    expect(projectAcpRegistryAgents(binaryOnly, "darwin-aarch64")[0]).toMatchObject({
      distributionKinds: ["binary"],
      available: false,
    });

    const config = await resolveAcpRegistryAgent(agent.agents[0]!, {
      platform: "linux-x86_64",
      installBinary: async () => "/managed/bin/agent",
    });
    expect(config.command).toBe("/managed/bin/agent");
    expect(config.args).toEqual(["serve"]);
  });

  it("maps Node platform names to exact registry platform keys", () => {
    expect(currentAcpPlatform("darwin", "arm64")).toBe("darwin-aarch64");
    expect(currentAcpPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(currentAcpPlatform("win32", "arm64")).toBe("windows-aarch64");
    expect(currentAcpPlatform("freebsd", "x64")).toBeNull();
  });

  it("rejects traversal and absolute archive or command paths", () => {
    expect(() => normalizeSafeArchivePath("../agent")).toThrow();
    expect(() => normalizeSafeArchivePath("/tmp/agent")).toThrow();
    expect(() => normalizeSafeArchivePath("C:\\tmp\\agent.exe")).toThrow();
    expect(() => normalizeSafeCommandPath("./../agent")).toThrow();
    expect(normalizeSafeCommandPath("./bin\\agent")).toBe("bin/agent");
  });
});

describe("ACP registry service cache", () => {
  let userDataDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "logos-acp-registry-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("uses fresh cache, revalidates with ETag, and falls back offline", async () => {
    const body = JSON.stringify({ version: "1.0.0", agents: [registryAgent()] });
    let calls = 0;
    let revalidationEtag: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      expect(init?.signal).toBeDefined();
      if (calls === 1) {
        return new Response(body, { status: 200, headers: { ETag: '"registry-v1"' } });
      }
      revalidationEtag = new Headers(init?.headers).get("If-None-Match");
      if (calls === 2) {
        return new Response(null, { status: 304, headers: { ETag: '"registry-v1"' } });
      }
      throw new Error("offline");
    }) as typeof globalThis.fetch;

    const ipc = createIpcHarness();
    registerAcpRegistryService({
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: () => undefined,
    } satisfies ServiceContext);

    const first = await ipc.invoke<AcpRegistryAgent[]>(CH.agentRegistryList);
    expect(first.map((agent) => agent.id)).toEqual(["example"]);
    expect(calls).toBe(1);

    await ipc.invoke<AcpRegistryAgent[]>(CH.agentRegistryList);
    expect(calls).toBe(1);

    await ipc.invoke<AcpRegistryAgent[]>(CH.agentRegistryList, true);
    expect(revalidationEtag).toBe('"registry-v1"');
    expect(calls).toBe(2);

    const offline = await ipc.invoke<AcpRegistryAgent[]>(CH.agentRegistryList, true);
    expect(offline.map((agent) => agent.id)).toEqual(["example"]);
    expect(calls).toBe(3);

    const cache = JSON.parse(
      await fs.readFile(path.join(userDataDir, ACP_REGISTRY_CACHE_FILE), "utf8"),
    ) as Record<string, unknown>;
    expect(cache.body).toBe(body);
    expect(cache.etag).toBe('"registry-v1"');
    expect(typeof cache.fetchedAt).toBe("number");
  });

  it("rejects an HTTPS registry redirect chain that downgrades to HTTP", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.test/registry.json" },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "http://example.test/registry-v2.json" },
      });
    }) as typeof globalThis.fetch;

    const ipc = createIpcHarness();
    registerAcpRegistryService({
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: () => undefined,
    } satisfies ServiceContext);

    await expect(ipc.invoke(CH.agentRegistryList)).rejects.toThrow("insecure URL");
    expect(calls).toBe(2);
  });

  it("rejects an HTTPS binary redirect that downgrades to HTTP", async () => {
    const platform = currentAcpPlatform();
    if (!platform) throw new Error("Test requires a supported ACP platform.");
    const body = JSON.stringify({
      version: "1.0.0",
      agents: [
        registryAgent({
          distribution: {
            binary: {
              [platform]: {
                archive: "https://example.test/agent",
                cmd: "agent",
                sha256: "a".repeat(64),
              },
            },
          },
        }),
      ],
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(body, { status: 200 });
      return new Response(null, {
        status: 302,
        headers: { Location: "http://example.test/agent" },
      });
    }) as typeof globalThis.fetch;

    const ipc = createIpcHarness();
    registerAcpRegistryService({
      ipcMain: ipc.ipcMain,
      userDataDir,
      getWindow: () => null,
      send: () => undefined,
    } satisfies ServiceContext);

    await expect(ipc.invoke(CH.agentRegistryResolve, "example")).rejects.toThrow("insecure URL");
    expect(calls).toBe(2);
  });
});
