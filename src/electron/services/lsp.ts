import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CH } from "../../shared/channels";
import type {
  LanguageServerDescriptor,
  LanguageServerInfo,
  LanguageServerStatus,
} from "../../shared/types";
import type { ServiceContext } from "./context";

// vscode-jsonrpc is kept external; load it via require in the CJS main bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rpc = require("vscode-jsonrpc/node") as typeof import("vscode-jsonrpc/node");

/** Built-in catalogue of common language servers, all installable from npm. */
const REGISTRY: (LanguageServerDescriptor & {
  /** npm package directory under node_modules/ that contains the server. */
  pkg: string;
  /** Path to the server's JS entry within its package (from its `bin` map). */
  entry: string;
  args: string[];
  /** Extra npm packages to install alongside this server's own package. */
  extraPackages?: string[];
  /**
   * Relative path under node_modules/ to a `tsserver.js`, handed to the server
   * as `initializationOptions.tsserver.fallbackPath`. typescript-language-server
   * ships no tsserver of its own and errors on initialize when the opened
   * workspace has no local `typescript`; a workspace-local copy still wins.
   */
  tsserverFallback?: string;
})[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    npmPackage: "typescript-language-server",
    description: "tsserver-backed language features for TS & JS.",
    pkg: "typescript-language-server",
    entry: "lib/cli.mjs",
    args: ["--stdio"],
    extraPackages: ["typescript"],
    tsserverFallback: "typescript/lib/tsserver.js",
  },
  {
    id: "python",
    label: "Python (Pyright)",
    languages: ["python"],
    npmPackage: "pyright",
    description: "Static type checker & language server for Python.",
    pkg: "pyright",
    entry: "langserver.index.js",
    args: ["--stdio"],
  },
  {
    id: "json",
    label: "JSON",
    languages: ["json", "jsonc"],
    npmPackage: "vscode-langservers-extracted",
    description: "JSON language features (schema validation, completion).",
    pkg: "vscode-langservers-extracted",
    entry: "bin/vscode-json-language-server",
    args: ["--stdio"],
  },
  {
    id: "html",
    label: "HTML",
    languages: ["html"],
    npmPackage: "vscode-langservers-extracted",
    description: "HTML language features (completion, hover, formatting).",
    pkg: "vscode-langservers-extracted",
    entry: "bin/vscode-html-language-server",
    args: ["--stdio"],
  },
  {
    id: "css",
    label: "CSS / SCSS / LESS",
    languages: ["css", "scss", "less"],
    npmPackage: "vscode-langservers-extracted",
    description: "CSS, SCSS & LESS language features.",
    pkg: "vscode-langservers-extracted",
    entry: "bin/vscode-css-language-server",
    args: ["--stdio"],
  },
  {
    id: "bash",
    label: "Bash",
    languages: ["shellscript"],
    npmPackage: "bash-language-server",
    description: "Shell script language server.",
    pkg: "bash-language-server",
    entry: "out/cli.js",
    args: ["start"],
  },
];

/** Notification methods that must use sendNotification (no response expected). */
const NOTIFICATIONS = new Set([
  "initialized",
  "exit",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/didSave",
  "workspace/didChangeConfiguration",
  "workspace/didChangeWatchedFiles",
  "$/cancelRequest",
]);

interface RunningServer {
  proc: ChildProcessWithoutNullStreams;
  connection: ReturnType<typeof rpc.createMessageConnection>;
  root: string;
}

export function registerLspService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const managedDir = path.join(ctx.userDataDir, "language-servers");
  const running = new Map<string, RunningServer>();
  const latestCache = new Map<string, string>();

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  // G1: a packaged app launched from the GUI inherits no login-shell PATH, so
  // bare `npm`/`node` are usually absent. Prepend the common install locations
  // (and any bundled bin dir) so spawns resolve. This is strictly additive.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  function augmentedEnv(): NodeJS.ProcessEnv {
    const sep = process.platform === "win32" ? ";" : ":";
    const extra = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      resourcesPath ? path.join(resourcesPath, "bin") : "",
    ].filter(Boolean);
    const current = process.env.PATH ?? "";
    return {
      ...process.env,
      PATH: [...extra, current].filter(Boolean).join(sep),
    };
  }
  function isMissingBinaryError(e: unknown): boolean {
    return (e as { code?: string } | null)?.code === "ENOENT";
  }

  // G1: search the npm-managed userData dir first so a user install/upgrade
  // (install() writes there) wins over the version bundled with a release; fall
  // back to servers bundled under resources/language-servers (no npm needed).
  const bundledDir = resourcesPath
    ? path.join(resourcesPath, "language-servers")
    : null;
  const searchDirs = [managedDir, bundledDir].filter(Boolean) as string[];

  function descriptor(id: string) {
    return REGISTRY.find((s) => s.id === id);
  }

  async function installedVersion(pkg: string): Promise<string | null> {
    for (const dir of searchDirs) {
      try {
        const pj = path.join(dir, "node_modules", pkg, "package.json");
        const raw = await fs.readFile(pj, "utf8");
        return (JSON.parse(raw).version as string) ?? null;
      } catch {
        /* try the next search dir */
      }
    }
    return null;
  }

  /** First on-disk path to a file under node_modules/ across the search dirs. */
  async function resolveModuleFile(relPath: string): Promise<string | null> {
    for (const dir of searchDirs) {
      const p = path.join(dir, "node_modules", relPath);
      try {
        await fs.access(p);
        return p;
      } catch {
        /* try the next search dir */
      }
    }
    return null;
  }

  /** First on-disk path to a server's JS entry across the search dirs. */
  function resolveEntry(
    s: LanguageServerDescriptor & { pkg: string; entry: string },
  ): Promise<string | null> {
    return resolveModuleFile(path.join(s.pkg, s.entry));
  }

  function latestVersion(pkg: string): Promise<string | null> {
    if (latestCache.has(pkg)) return Promise.resolve(latestCache.get(pkg)!);
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(npmCmd, ["view", pkg, "version"], {
        cwd: managedDir,
        env: augmentedEnv(),
      });
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => {
        const v = out.trim() || null;
        if (v) latestCache.set(pkg, v);
        resolve(v);
      });
    });
  }

  function progress(
    id: string,
    status: LanguageServerStatus,
    message?: string,
    p?: number,
  ) {
    ctx.send(CH.lspProgress, { id, status, message, progress: p });
  }

  async function ensureManagedDir() {
    await fs.mkdir(managedDir, { recursive: true });
    const pj = path.join(managedDir, "package.json");
    try {
      await fs.access(pj);
    } catch {
      await fs.writeFile(
        pj,
        JSON.stringify({ name: "logos-language-servers", private: true }, null, 2),
      );
    }
  }

  async function list(): Promise<LanguageServerInfo[]> {
    await ensureManagedDir();
    return Promise.all(
      REGISTRY.map(async (s): Promise<LanguageServerInfo> => {
        const installed = s.npmPackage
          ? await installedVersion(s.npmPackage)
          : null;
        let status: LanguageServerStatus = installed
          ? "installed"
          : "not-installed";
        if (running.has(s.id)) status = "running";
        return {
          id: s.id,
          label: s.label,
          languages: s.languages,
          npmPackage: s.npmPackage,
          description: s.description,
          status,
          installedVersion: installed,
          latestVersion: null,
        };
      }),
    );
  }

  function install(id: string): Promise<void> {
    const s = descriptor(id);
    if (!s?.npmPackage) return Promise.resolve();
    return ensureManagedDir().then(
      () =>
        new Promise<void>((resolve, reject) => {
          progress(id, "installing", `Installing ${s.npmPackage}…`);
          // Co-install any runtime deps (e.g. `typescript` for the TS server,
          // which bundles no tsserver) in the same atomic npm invocation.
          const pkgs = [s.npmPackage!, ...(s.extraPackages ?? [])];
          const child = spawn(
            npmCmd,
            [
              "install",
              ...pkgs.map((p) => `${p}@latest`),
              "--prefix",
              managedDir,
              "--no-audit",
              "--no-fund",
              "--no-save",
            ],
            { cwd: managedDir, env: augmentedEnv() },
          );
          let err = "";
          let errored = false;
          child.stderr?.on("data", (d) => (err += d.toString()));
          // Spawn failure (npm/node not on PATH) — must surface, not swallow.
          child.on("error", (e) => {
            errored = true;
            const msg = isMissingBinaryError(e)
              ? "Node.js / npm not found. Install Node.js and ensure it is on PATH."
              : e.message;
            progress(id, "error", msg);
            reject(new Error(msg));
          });
          child.on("close", async (code) => {
            // After a spawn failure Node also fires `close` (code = the negative
            // errno, e.g. -2 for ENOENT). The `error` handler already reported a
            // clear message — don't clobber it with a bogus "exited with code -2".
            if (errored) return;
            if (code === 0) {
              const v = await installedVersion(s.npmPackage!);
              progress(id, "installed", `Installed ${s.npmPackage}@${v}`);
              resolve();
            } else {
              // Non-zero exit means the package is NOT on disk — reject so
              // ensureServer never proceeds to start() against a missing bin.
              // A null/negative code is a launch failure (signal / could not
              // run), not a real exit status, so report it as such.
              const detail =
                err.split("\n").filter(Boolean).slice(-3).join("\n").trim() ||
                (code == null || code < 0
                  ? "Could not run npm. Install Node.js and ensure it is on PATH."
                  : `npm exited with code ${code}`);
              progress(id, "error", detail);
              reject(new Error(detail));
            }
          });
        }),
    );
  }

  async function uninstall(id: string): Promise<void> {
    const s = descriptor(id);
    if (!s?.npmPackage) return;
    await stop(id);
    await fs
      .rm(path.join(managedDir, "node_modules", s.npmPackage), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
    progress(id, "not-installed");
  }

  async function start(id: string, root: string): Promise<void> {
    const s = descriptor(id);
    if (!s) throw new Error(`Unknown language server: ${id}`);
    if (running.has(id)) return;

    // A2: verify the entry is actually on disk before spawning, so a
    // failed/half install surfaces a clear error instead of a swallowed spawn.
    const entry = await resolveEntry(s);
    if (!entry) {
      const msg = `${s.label} is not installed`;
      progress(id, "error", msg);
      throw new Error(msg);
    }
    progress(id, "starting", `Starting ${s.label}…`);

    // G1: run the server with Electron's own Node (ELECTRON_RUN_AS_NODE) instead
    // of its `#!/usr/bin/env node` bin shim. A GUI-launched packaged app has no
    // node/npm on PATH, so spawning the shim would fail with ENOENT (the
    // "exited with code -2" symptom). process.execPath is always present.
    const proc = spawn(process.execPath, [entry, ...s.args], {
      cwd: root,
      env: { ...augmentedEnv(), ELECTRON_RUN_AS_NODE: "1" },
    }) as ChildProcessWithoutNullStreams;

    proc.on("error", (e) => {
      progress(id, "error", e.message);
      running.delete(id);
    });
    proc.on("exit", () => {
      running.delete(id);
      progress(id, "stopped");
    });

    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(proc.stdout),
      new rpc.StreamMessageWriter(proc.stdin),
    );

    connection.onNotification((method: string, params: unknown) => {
      ctx.send(CH.lspNotify, { serverId: id, method, params });
    });
    // Answer the few server->client requests that block initialization.
    connection.onRequest("workspace/configuration", (p: { items: unknown[] }) =>
      (p.items ?? []).map(() => ({})),
    );
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.listen();

    running.set(id, { proc, connection, root });

    try {
      // typescript-language-server has no tsserver of its own. Hand it our staged
      // `typescript` as a fallback so TS/JS features work even when the opened
      // workspace has no local copy (a workspace-local typescript still wins).
      let initializationOptions: Record<string, unknown> | undefined;
      if (s.tsserverFallback) {
        const tsserverPath = await resolveModuleFile(s.tsserverFallback);
        if (tsserverPath)
          initializationOptions = { tsserver: { fallbackPath: tsserverPath } };
      }

      const rootUri = pathToFileURL(root).toString();
      await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        rootPath: root,
        initializationOptions,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
              },
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      });
      connection.sendNotification("initialized", {});
      progress(id, "running", `${s.label} ready`);
    } catch (e) {
      // initialize rejected (or a later step threw): tear down the half-started
      // instance and drop it from `running`, otherwise the guard at the top of
      // start() would block every later attempt to launch this server.
      running.delete(id);
      try {
        connection.dispose();
      } catch {
        /* already gone */
      }
      proc.kill();
      const msg = e instanceof Error ? e.message : String(e);
      progress(id, "error", msg);
      throw e instanceof Error ? e : new Error(msg);
    }
  }

  async function stop(id: string): Promise<void> {
    const server = running.get(id);
    if (!server) return;
    running.delete(id);
    try {
      await server.connection.sendRequest("shutdown");
      server.connection.sendNotification("exit");
    } catch {
      /* ignore */
    }
    server.connection.dispose();
    server.proc.kill();
    progress(id, "stopped");
  }

  ipcMain.handle(CH.lspList, () => list());
  ipcMain.handle(CH.lspInstall, (_e, id: string) => install(id));
  ipcMain.handle(CH.lspUninstall, (_e, id: string) => uninstall(id));
  ipcMain.handle(CH.lspStart, (_e, id: string, root: string) => start(id, root));
  ipcMain.handle(CH.lspStop, (_e, id: string) => stop(id));
  ipcMain.handle(
    CH.lspRequest,
    async (_e, id: string, method: string, params: unknown) => {
      const server = running.get(id);
      if (!server) return null;
      if (NOTIFICATIONS.has(method)) {
        server.connection.sendNotification(method, params);
        return null;
      }
      return server.connection.sendRequest(method, params);
    },
  );

  // Best-effort latest-version probe (network); used by the Extensions/LSP view.
  ipcMain.handle("lsp:checkUpdates", async () => {
    const result: Record<string, string | null> = {};
    for (const s of REGISTRY)
      if (s.npmPackage) result[s.id] = await latestVersion(s.npmPackage);
    return result;
  });

  return () => {
    for (const id of [...running.keys()]) void stop(id);
  };
}
