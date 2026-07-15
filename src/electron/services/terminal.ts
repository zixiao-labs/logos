import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { IPty } from "node-pty";
import { CH } from "../../shared/channels";
import type { TerminalCreateOptions, TerminalCreated } from "../../shared/types";
import type { ServiceContext } from "./context";

function loadPty(): typeof import("node-pty") {
  // node-pty is a native module kept external from the bundle.
  return require("node-pty") as typeof import("node-pty");
}

function defaultShell(): string {
  if (process.platform === "win32")
    return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

function augmentPath(env: Record<string, string>): void {
  const separator = process.platform === "win32" ? ";" : ":";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates =
    process.platform === "win32"
      ? []
      : [
          path.join(os.homedir(), ".opencode", "bin"),
          path.join(os.homedir(), ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ];
  if (resourcesPath) candidates.unshift(path.join(resourcesPath, "bin"));
  env.PATH = [...candidates, env.PATH ?? ""].filter(Boolean).join(separator);
}

export function registerTerminalService(
  ctx: ServiceContext,
  pty = loadPty(),
): () => void {
  const { ipcMain } = ctx;
  const terminals = new Map<string, IPty>();
  let counter = 0;

  const createTerminal = (opts: TerminalCreateOptions): TerminalCreated => {
    const id = `term-${++counter}`;
    const shell = opts.executable || opts.shell || defaultShell();
    const env = { ...process.env } as Record<string, string>;
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
    augmentPath(env);
    env.TERM = "xterm-256color";
    const proc = pty.spawn(shell, opts.args ?? [], {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd || os.homedir(),
      env,
    });
    terminals.set(id, proc);

    proc.onData((data) => ctx.send(CH.terminalData, { id, data }));
    proc.onExit(({ exitCode }) => {
      ctx.send(CH.terminalExit, { id, code: exitCode });
      terminals.delete(id);
    });

    return { id, pid: proc.pid, shell };
  };

  const killTerminal = (id: string) => {
    try {
      terminals.get(id)?.kill();
    } finally {
      terminals.delete(id);
    }
  };

  ctx.terminal = { create: createTerminal, kill: killTerminal };

  ipcMain.handle(
    CH.terminalCreate,
    (_e, opts: TerminalCreateOptions): TerminalCreated => createTerminal(opts),
  );

  // These are fire-and-forget (`send` from renderer), registered with `on`.
  ipcMain.on(CH.terminalWrite, (_e, id: string, data: string) => {
    terminals.get(id)?.write(data);
  });

  ipcMain.on(CH.terminalResize, (_e, id: string, cols: number, rows: number) => {
    try {
      terminals.get(id)?.resize(Math.max(cols, 1), Math.max(rows, 1));
    } catch {
      /* resize can throw if the pty just exited */
    }
  });

  ipcMain.on(CH.terminalKill, (_e, id: string) => {
    killTerminal(id);
  });

  return () => {
    for (const p of terminals.values()) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    terminals.clear();
    if (ctx.terminal?.create === createTerminal) delete ctx.terminal;
  };
}
