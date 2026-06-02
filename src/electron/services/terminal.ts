import os from "node:os";
import process from "node:process";
import type { IPty } from "node-pty";
import { CH } from "../../shared/channels";
import type { TerminalCreateOptions, TerminalCreated } from "../../shared/types";
import type { ServiceContext } from "./context";

// node-pty is a native module kept external from the bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty: typeof import("node-pty") = require("node-pty");

function defaultShell(): string {
  if (process.platform === "win32")
    return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

export function registerTerminalService(ctx: ServiceContext): () => void {
  const { ipcMain } = ctx;
  const terminals = new Map<string, IPty>();
  let counter = 0;

  ipcMain.handle(
    CH.terminalCreate,
    (_e, opts: TerminalCreateOptions): TerminalCreated => {
      const id = `term-${++counter}`;
      const shell = opts.shell || defaultShell();
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd || os.homedir(),
        env: { ...process.env, TERM: "xterm-256color" } as Record<
          string,
          string
        >,
      });
      terminals.set(id, proc);

      proc.onData((data) => ctx.send(CH.terminalData, { id, data }));
      proc.onExit(({ exitCode }) => {
        ctx.send(CH.terminalExit, { id, code: exitCode });
        terminals.delete(id);
      });

      return { id, pid: proc.pid, shell };
    },
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
    terminals.get(id)?.kill();
    terminals.delete(id);
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
  };
}
