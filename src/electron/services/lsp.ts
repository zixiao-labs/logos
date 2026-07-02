import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import { CH } from "../../shared/channels";
import type {
  LanguageServerDescriptor,
  LanguageServerInfo,
  LanguageServerStatus,
  LspLogLevel,
} from "../../shared/types";
import type { ServiceContext } from "./context";

// vscode-jsonrpc is kept external; load it via require in the CJS main bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rpc = require("vscode-jsonrpc/node") as typeof import("vscode-jsonrpc/node");

const gunzip = promisify(gunzipCb);

type BaseRegistryEntry = LanguageServerDescriptor & { args: string[] };

type NpmLanguageServer = BaseRegistryEntry & {
  installKind: "npm";
  /** npm package directory under node_modules/ that contains the server. */
  npmPackage: string;
  /** Path to the server's JS entry within its package (from its `bin` map). */
  pkg: string;
  entry: string;
  /** Extra npm packages to install alongside this server's own package. */
  extraPackages?: string[];
  /** See TypeScript entry below: fallback `typescript/lib/tsserver.js`. */
  tsserverFallback?: string;
};

type GoInstallLanguageServer = BaseRegistryEntry & {
  installKind: "go-install";
  executable: string;
  goModule: string;
  versionArgs: string[];
};

type RustAnalyzerLanguageServer = BaseRegistryEntry & {
  installKind: "rust-analyzer-release";
  executable: string;
  versionArgs: string[];
};

type BinaryLanguageServer = GoInstallLanguageServer | RustAnalyzerLanguageServer;
type RegistryEntry = NpmLanguageServer | BinaryLanguageServer;

function executableName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

/** Built-in catalogue of common language servers. */
const REGISTRY: RegistryEntry[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    npmPackage: "typescript-language-server",
    description: "tsserver-backed language features for TS & JS.",
    installKind: "npm",
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
    installKind: "npm",
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
    installKind: "npm",
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
    installKind: "npm",
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
    installKind: "npm",
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
    installKind: "npm",
    pkg: "bash-language-server",
    entry: "out/cli.js",
    args: ["start"],
  },
  {
    id: "go",
    label: "Go (gopls)",
    languages: ["go"],
    description: "Official Go language server, installed with `go install`.",
    installKind: "go-install",
    executable: executableName("gopls"),
    goModule: "golang.org/x/tools/gopls@latest",
    args: [],
    versionArgs: ["version"],
  },
  {
    id: "rust-analyzer",
    label: "Rust Analyzer",
    languages: ["rust"],
    description: "Official Rust language server downloaded from GitHub releases.",
    installKind: "rust-analyzer-release",
    executable: executableName("rust-analyzer"),
    args: [],
    versionArgs: ["--version"],
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
  "workspace/didChangeWorkspaceFolders",
  "$/cancelRequest",
  "$/setTrace",
]);

interface RunningServer {
  proc: ChildProcessWithoutNullStreams;
  connection: ReturnType<typeof rpc.createMessageConnection>;
  root: string;
}

interface ServerCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function isNpmServer(s: RegistryEntry): s is NpmLanguageServer {
  return s.installKind === "npm";
}

function isBinaryServer(s: RegistryEntry): s is BinaryLanguageServer {
  return s.installKind !== "npm";
}

export function registerLspService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const managedDir = path.join(ctx.userDataDir, "language-servers");
  const managedBinDir = path.join(managedDir, "bin");
  const running = new Map<string, RunningServer>();
  const latestCache = new Map<string, string>();

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const goCmd = process.platform === "win32" ? "go.exe" : "go";

  // G1: a packaged app launched from the GUI inherits no login-shell PATH, so
  // bare `npm`/`node`/`go` are often absent. Prepend the common install locations
  // (and any bundled bin dir) so spawns resolve. This is strictly additive.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  function augmentedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const sep = process.platform === "win32" ? ";" : ":";
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const platformPaths =
      process.platform === "win32"
        ? ["C:\\Program Files\\Go\\bin"]
        : ["/usr/local/go/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
    const extraPaths = [
      managedBinDir,
      ...platformPaths,
      home ? path.join(home, "go", "bin") : "",
      resourcesPath ? path.join(resourcesPath, "bin") : "",
    ].filter(Boolean);
    const current = extra.PATH ?? process.env.PATH ?? "";
    return {
      ...process.env,
      ...extra,
      PATH: [...extraPaths, current].filter(Boolean).join(sep),
    };
  }
  function isMissingBinaryError(e: unknown): boolean {
    return (e as { code?: string } | null)?.code === "ENOENT";
  }

  // G1: search the npm/go-managed userData dir first so a user install/upgrade
  // wins over the version bundled with a release; fall back to servers bundled
  // under resources/language-servers (no npm/go needed for those).
  const bundledDir = resourcesPath
    ? path.join(resourcesPath, "language-servers")
    : null;
  const searchDirs = [managedDir, bundledDir].filter(Boolean) as string[];

  function descriptor(id: string): RegistryEntry | undefined {
    return REGISTRY.find((s) => s.id === id);
  }

  function log(serverId: string | undefined, level: LspLogLevel, message: string) {
    const lines = String(message)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    for (const line of lines) {
      ctx.send(CH.lspLog, { time: Date.now(), serverId, level, message: line });
    }
  }

  function logChunk(
    serverId: string | undefined,
    level: LspLogLevel,
    chunk: Buffer | string,
  ) {
    log(serverId, level, chunk.toString());
  }

  function progress(
    id: string,
    status: LanguageServerStatus,
    message?: string,
    p?: number,
  ) {
    ctx.send(CH.lspProgress, { id, status, message, progress: p });
    if (message) log(id, status === "error" ? "error" : "info", message);
  }

  async function ensureManagedDir() {
    await fs.mkdir(managedDir, { recursive: true });
    await fs.mkdir(managedBinDir, { recursive: true });
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

  function resolveEntry(s: NpmLanguageServer): Promise<string | null> {
    return resolveModuleFile(path.join(s.pkg, s.entry));
  }

  async function resolveBinary(s: BinaryLanguageServer): Promise<string | null> {
    for (const dir of searchDirs) {
      const p = path.join(dir, "bin", s.executable);
      try {
        await fs.access(p);
        return p;
      } catch {
        /* try the next search dir */
      }
    }
    return null;
  }

  async function resolveServerCommand(s: RegistryEntry): Promise<ServerCommand | null> {
    if (isNpmServer(s)) {
      const entry = await resolveEntry(s);
      if (!entry) return null;
      // G1: run Node-based servers with Electron's own Node instead of their
      // `#!/usr/bin/env node` bin shim. A GUI-launched packaged app has no login
      // shell PATH, while process.execPath is always present.
      return {
        command: process.execPath,
        args: [entry, ...s.args],
        env: augmentedEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      };
    }

    const binary = await resolveBinary(s);
    if (!binary) return null;
    return { command: binary, args: s.args, env: augmentedEnv() };
  }

  async function npmInstalledVersion(pkg: string): Promise<string | null> {
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

  function normalizeVersionOutput(id: string, output: string): string | null {
    const first = output.trim().split(/\r?\n/).find(Boolean)?.trim();
    if (!first) return null;
    if (id === "rust-analyzer") return first.replace(/^rust-analyzer\s+/, "");
    if (id === "go") return first.match(/\bv\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? first;
    return first;
  }

  function binaryInstalledVersion(s: BinaryLanguageServer): Promise<string | null> {
    return new Promise((resolve) => {
      void resolveBinary(s).then((binary) => {
        if (!binary) {
          resolve(null);
          return;
        }
        let out = "";
        let err = "";
        let done = false;
        const child = spawn(binary, s.versionArgs, { env: augmentedEnv() });
        const finish = (value: string | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(null);
        }, 5000);
        child.stdout?.on("data", (d) => (out += d.toString()));
        child.stderr?.on("data", (d) => (err += d.toString()));
        child.on("error", () => finish(null));
        child.on("close", (code) => {
          if (code !== 0) finish(null);
          else finish(normalizeVersionOutput(s.id, out || err));
        });
      });
    });
  }

  function installedVersion(s: RegistryEntry): Promise<string | null> {
    return isNpmServer(s) ? npmInstalledVersion(s.npmPackage) : binaryInstalledVersion(s);
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

  function runProcess(
    id: string,
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
    missingBinaryMessage: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let errored = false;
      const child = spawn(command, args, options);
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
        logChunk(id, "info", d);
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
        logChunk(id, "warning", d);
      });
      child.on("error", (e) => {
        errored = true;
        const msg = isMissingBinaryError(e) ? missingBinaryMessage : e.message;
        progress(id, "error", msg);
        reject(new Error(msg));
      });
      child.on("close", (code) => {
        if (errored) return;
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail =
          stderr.split("\n").filter(Boolean).slice(-3).join("\n").trim() ||
          (code == null || code < 0
            ? `Could not run ${command}.`
            : `${command} exited with code ${code}`);
        progress(id, "error", detail);
        reject(new Error(detail));
      });
    });
  }

  async function list(): Promise<LanguageServerInfo[]> {
    await ensureManagedDir();
    return Promise.all(
      REGISTRY.map(async (s): Promise<LanguageServerInfo> => {
        const installed = await installedVersion(s);
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

  async function installNpm(s: NpmLanguageServer): Promise<void> {
    await ensureManagedDir();
    progress(s.id, "installing", `Installing ${s.npmPackage}…`);
    // Co-install any runtime deps (e.g. `typescript` for the TS server, which
    // bundles no tsserver) in the same atomic npm invocation.
    const pkgs = [s.npmPackage, ...(s.extraPackages ?? [])];
    await runProcess(
      s.id,
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
      "Node.js / npm not found. Install Node.js and ensure it is on PATH.",
    );
    const v = await installedVersion(s);
    progress(s.id, "installed", `Installed ${s.npmPackage}${v ? `@${v}` : ""}`);
  }

  async function installGo(s: GoInstallLanguageServer): Promise<void> {
    await ensureManagedDir();
    progress(s.id, "installing", `Installing ${s.label} with go install…`);
    await runProcess(
      s.id,
      goCmd,
      ["install", s.goModule],
      { cwd: managedDir, env: augmentedEnv({ GOBIN: managedBinDir }) },
      "Go toolchain not found. Install Go and ensure the `go` command is on PATH.",
    );
    const v = await installedVersion(s);
    progress(s.id, "installed", `Installed ${s.label}${v ? ` ${v}` : ""}`);
  }

  function rustAnalyzerAssetName(): string | null {
    const arch =
      process.arch === "arm64"
        ? "aarch64"
        : process.arch === "x64"
          ? "x86_64"
          : process.arch === "ia32"
            ? "i686"
            : process.arch === "arm"
              ? "arm"
              : null;
    if (!arch) return null;

    if (process.platform === "darwin") {
      if (arch !== "aarch64" && arch !== "x86_64") return null;
      return `rust-analyzer-${arch}-apple-darwin.gz`;
    }
    if (process.platform === "linux") {
      if (arch === "arm") return "rust-analyzer-arm-unknown-linux-gnueabihf.gz";
      if (arch !== "aarch64" && arch !== "x86_64") return null;
      return `rust-analyzer-${arch}-unknown-linux-gnu.gz`;
    }
    if (process.platform === "win32") {
      if (arch !== "aarch64" && arch !== "x86_64" && arch !== "i686") return null;
      return `rust-analyzer-${arch}-pc-windows-msvc.zip`;
    }
    return null;
  }

  function downloadBuffer(
    url: string,
    id: string,
    redirectCount = 0,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects while downloading rust-analyzer."));
        return;
      }
      const client = url.startsWith("http:") ? http : https;
      const req = client.get(
        url,
        { headers: { "User-Agent": "Logos" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            const next = new URL(res.headers.location, url).toString();
            res.resume();
            resolve(downloadBuffer(next, id, redirectCount + 1));
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`Download failed with HTTP ${status}`));
            return;
          }

          const chunks: Buffer[] = [];
          const total = Number(res.headers["content-length"] ?? 0);
          let received = 0;
          let lastLoggedPct = 0;
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            if (total > 0) {
              const pct = Math.floor((received / total) * 100);
              if (pct === 100 || pct >= lastLoggedPct + 25) {
                lastLoggedPct = pct;
                progress(id, "installing", `Downloading rust-analyzer ${pct}%`, pct / 100);
              }
            }
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
    });
  }

  function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  async function installRustAnalyzer(s: RustAnalyzerLanguageServer): Promise<void> {
    await ensureManagedDir();
    const asset = rustAnalyzerAssetName();
    if (!asset) {
      const msg = `rust-analyzer download is not available for ${process.platform}/${process.arch}.`;
      progress(s.id, "error", msg);
      throw new Error(msg);
    }

    const url = `https://github.com/rust-lang/rust-analyzer/releases/latest/download/${asset}`;
    const tmpDir = path.join(managedDir, "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const target = path.join(managedBinDir, s.executable);
    const stamp = `${process.pid}-${Date.now()}`;
    const partial = path.join(tmpDir, `${s.executable}-${stamp}`);
    const archivePath = path.join(tmpDir, `${asset}-${stamp}`);
    const extractDir = path.join(tmpDir, `rust-analyzer-${stamp}`);

    progress(s.id, "installing", `Downloading ${asset}…`);
    try {
      const data = await downloadBuffer(url, s.id);
      if (asset.endsWith(".gz")) {
        const binary = await gunzip(data);
        await fs.writeFile(partial, binary);
        await fs.chmod(partial, 0o755).catch(() => undefined);
        await fs.rename(partial, target);
      } else if (asset.endsWith(".zip")) {
        await fs.writeFile(archivePath, data);
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.mkdir(extractDir, { recursive: true });
        await runProcess(
          s.id,
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
          ],
          { cwd: managedDir, env: augmentedEnv() },
          "PowerShell not found. Cannot extract rust-analyzer on Windows.",
        );
        await fs.copyFile(path.join(extractDir, s.executable), target);
      } else {
        throw new Error(`Unsupported rust-analyzer asset type: ${asset}`);
      }
      const v = await installedVersion(s);
      progress(s.id, "installed", `Installed ${s.label}${v ? ` ${v}` : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      progress(s.id, "error", msg);
      throw e instanceof Error ? e : new Error(msg);
    } finally {
      await fs.rm(partial, { force: true }).catch(() => undefined);
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function install(id: string): Promise<void> {
    const s = descriptor(id);
    if (!s) throw new Error(`Unknown language server: ${id}`);
    if (s.installKind === "npm") return installNpm(s);
    if (s.installKind === "go-install") return installGo(s);
    return installRustAnalyzer(s);
  }

  async function uninstall(id: string): Promise<void> {
    const s = descriptor(id);
    if (!s) return;
    await stop(id);
    if (isNpmServer(s)) {
      await fs
        .rm(path.join(managedDir, "node_modules", s.npmPackage), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
    } else {
      await fs.rm(path.join(managedBinDir, s.executable), { force: true }).catch(() => undefined);
    }
    progress(id, "not-installed");
  }

  function logServerMessage(id: string, method: string, params: unknown) {
    if (method !== "window/logMessage" && method !== "window/showMessage") {
      if (method === "$/logTrace") {
        const p = params as { message?: unknown; verbose?: unknown };
        log(
          id,
          "debug",
          [p.message, p.verbose].filter((x) => x != null).map(String).join(" "),
        );
      }
      return;
    }
    const p = params as { type?: number; message?: unknown };
    const level: LspLogLevel =
      p.type === 1 ? "error" : p.type === 2 ? "warning" : p.type === 4 ? "debug" : "info";
    if (p.message != null) log(id, level, String(p.message));
  }

  async function start(id: string, root: string): Promise<void> {
    const s = descriptor(id);
    if (!s) throw new Error(`Unknown language server: ${id}`);
    if (running.has(id)) return;

    // A2: verify the entry/binary is actually on disk before spawning, so a
    // failed/half install surfaces a clear error instead of a swallowed spawn.
    const resolved = await resolveServerCommand(s);
    if (!resolved) {
      const msg = `${s.label} is not installed`;
      progress(id, "error", msg);
      throw new Error(msg);
    }
    progress(id, "starting", `Starting ${s.label}…`);

    // Set when initialize fails below: killing the process there fires the exit
    // handler, which would otherwise clobber the "error" state with "stopped".
    let initFailed = false;

    const proc = spawn(resolved.command, resolved.args, {
      cwd: root,
      env: resolved.env,
    }) as ChildProcessWithoutNullStreams;

    proc.stderr?.on("data", (d) => logChunk(id, "debug", d));
    proc.on("error", (e) => {
      progress(id, "error", e.message);
      running.delete(id);
    });
    proc.on("exit", (code, signal) => {
      running.delete(id);
      if (!initFailed) {
        const suffix = signal ? ` (${signal})` : code == null ? "" : ` (${code})`;
        progress(id, "stopped", `${s.label} stopped${suffix}`);
      }
    });

    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(proc.stdout),
      new rpc.StreamMessageWriter(proc.stdin),
    );

    const rootUri = pathToFileURL(root).toString();

    connection.onNotification((method: string, params: unknown) => {
      logServerMessage(id, method, params);
      ctx.send(CH.lspNotify, { serverId: id, method, params });
    });
    // Answer the few server->client requests that block initialization or common
    // server features. Unsupported client actions are rejected gracefully.
    connection.onRequest("workspace/configuration", (p: { items: unknown[] }) =>
      (p.items ?? []).map(() => ({})),
    );
    connection.onRequest("workspace/workspaceFolders", () => [
      { uri: rootUri, name: path.basename(root) },
    ]);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("window/showMessageRequest", (p: unknown) => {
      logServerMessage(id, "window/showMessage", p);
      return null;
    });
    connection.onRequest("workspace/applyEdit", () => ({ applied: false }));
    connection.listen();

    running.set(id, { proc, connection, root });

    try {
      // typescript-language-server has no tsserver of its own. Hand it our staged
      // `typescript` as a fallback so TS/JS features work even when the opened
      // workspace has no local copy (a workspace-local typescript still wins).
      let initializationOptions: Record<string, unknown> | undefined;
      if (isNpmServer(s) && s.tsserverFallback) {
        const tsserverPath = await resolveModuleFile(s.tsserverFallback);
        if (tsserverPath)
          initializationOptions = { tsserver: { fallbackPath: tsserverPath } };
      }

      await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        rootPath: root,
        initializationOptions,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            completion: {
              dynamicRegistration: false,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                resolveSupport: {
                  properties: ["documentation", "detail", "additionalTextEdits"],
                },
              },
            },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            applyEdit: false,
          },
          window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      });
      connection.sendNotification("initialized", {});
      progress(id, "running", `${s.label} ready`);
    } catch (e) {
      // initialize rejected (or a later step threw): tear down the half-started
      // instance and drop it from `running`, otherwise the guard at the top of
      // start() would block every later attempt to launch this server.
      initFailed = true;
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
    for (const s of REGISTRY) {
      result[s.id] = isNpmServer(s) ? await latestVersion(s.npmPackage) : null;
    }
    return result;
  });

  return () => {
    for (const id of [...running.keys()]) void stop(id);
  };
}
