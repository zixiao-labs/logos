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
  bin: string;
  args: string[];
})[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    npmPackage: "typescript-language-server",
    description: "tsserver-backed language features for TS & JS.",
    bin: "typescript-language-server",
    args: ["--stdio"],
  },
  {
    id: "python",
    label: "Python (Pyright)",
    languages: ["python"],
    npmPackage: "pyright",
    description: "Static type checker & language server for Python.",
    bin: "pyright-langserver",
    args: ["--stdio"],
  },
  {
    id: "json",
    label: "JSON",
    languages: ["json", "jsonc"],
    npmPackage: "vscode-langservers-extracted",
    description: "JSON language features (schema validation, completion).",
    bin: "vscode-json-language-server",
    args: ["--stdio"],
  },
  {
    id: "html",
    label: "HTML / CSS",
    languages: ["html", "css", "scss", "less"],
    npmPackage: "vscode-langservers-extracted",
    description: "HTML & CSS language features.",
    bin: "vscode-html-language-server",
    args: ["--stdio"],
  },
  {
    id: "bash",
    label: "Bash",
    languages: ["shellscript"],
    npmPackage: "bash-language-server",
    description: "Shell script language server.",
    bin: "bash-language-server",
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
  const binExt = process.platform === "win32" ? ".cmd" : "";

  function descriptor(id: string) {
    return REGISTRY.find((s) => s.id === id);
  }

  async function installedVersion(pkg: string): Promise<string | null> {
    try {
      const pj = path.join(managedDir, "node_modules", pkg, "package.json");
      const raw = await fs.readFile(pj, "utf8");
      return JSON.parse(raw).version ?? null;
    } catch {
      return null;
    }
  }

  function latestVersion(pkg: string): Promise<string | null> {
    if (latestCache.has(pkg)) return Promise.resolve(latestCache.get(pkg)!);
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(npmCmd, ["view", pkg, "version"], {
        cwd: managedDir,
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
        new Promise<void>((resolve) => {
          progress(id, "installing", `Installing ${s.npmPackage}…`);
          const child = spawn(
            npmCmd,
            [
              "install",
              `${s.npmPackage}@latest`,
              "--prefix",
              managedDir,
              "--no-audit",
              "--no-fund",
              "--no-save",
            ],
            { cwd: managedDir },
          );
          let err = "";
          child.stderr?.on("data", (d) => (err += d.toString()));
          child.on("error", (e) => {
            progress(id, "error", e.message);
            resolve();
          });
          child.on("close", async (code) => {
            if (code === 0) {
              const v = await installedVersion(s.npmPackage!);
              progress(id, "installed", `Installed ${s.npmPackage}@${v}`);
            } else {
              progress(id, "error", err.split("\n").slice(-3).join("\n"));
            }
            resolve();
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

    const binPath = path.join(managedDir, "node_modules", ".bin", s.bin + binExt);
    progress(id, "starting", `Starting ${s.label}…`);

    const proc = spawn(binPath, s.args, {
      cwd: root,
      env: process.env,
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

    const rootUri = pathToFileURL(root).toString();
    await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: root,
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
