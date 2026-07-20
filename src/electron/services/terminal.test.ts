import { describe, expect, it } from "@lightning-js/lightning";
import type { IDisposable, IPty } from "node-pty";
import { CH } from "../../shared/channels";
import type { TerminalCreated } from "../../shared/types";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerTerminalService } from "./terminal";

function disposable(): IDisposable {
  return { dispose: () => undefined };
}

describe("terminal service", () => {
  it("creates a PTY and forwards data, writes, resize, kill, and exit events", async () => {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    let kills = 0;
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number; signal?: number }) => void =
      () => undefined;
    let spawnArgs: unknown[] = [];
    const proc = {
      pid: 42,
      write: (data: string) => writes.push(data),
      resize: (cols: number, rows: number) => resizes.push([cols, rows]),
      kill: () => {
        kills++;
      },
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return disposable();
      },
      onExit: (listener: typeof onExit) => {
        onExit = listener;
        return disposable();
      },
    } as unknown as IPty;
    const pty = {
      spawn: (...args: unknown[]) => {
        spawnArgs = args;
        return proc;
      },
    } as unknown as typeof import("node-pty");
    const cleanup = registerTerminalService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp",
        getWindow: () => null,
        isTrustedSender: () => true,
        send: (channel: string, ...args: unknown[]) =>
          sent.push([channel, ...args]),
      } satisfies ServiceContext,
      pty,
    );

    const created = await ipc.invoke<TerminalCreated>(CH.terminalCreate, {
      shell: "/bin/test-shell",
      cwd: "/workspace",
      cols: 120,
      rows: 40,
      env: { PATH: `/custom/bin${process.platform === "win32" ? ";" : ":"}/usr/bin` },
    });
    expect(created).toEqual({
      id: "term-1",
      pid: 42,
      shell: "/bin/test-shell",
    });
    expect(spawnArgs[0]).toBe("/bin/test-shell");
    expect(spawnArgs[2]).toMatchObject({
      cwd: "/workspace",
      cols: 120,
      rows: 40,
      name: "xterm-256color",
    });
    const spawnedEnv = (spawnArgs[2] as { env: Record<string, string> }).env;
    const pathKey = Object.keys(spawnedEnv).find(
      (key) => key.toLowerCase() === "path",
    );
    const pathEntries = spawnedEnv[pathKey!].split(
      process.platform === "win32" ? ";" : ":",
    );
    expect(pathEntries).toContain("/custom/bin");
    expect(pathEntries.indexOf("/custom/bin")).toBeLessThan(
      pathEntries.indexOf("/usr/bin"),
    );
    expect(pathEntries.filter((entry) => entry === "/usr/bin")).toHaveLength(1);

    ipc.emit(CH.terminalWrite, created.id, "echo test\r");
    ipc.emit(CH.terminalResize, created.id, 0, -4);
    onData("output");
    expect(writes).toEqual(["echo test\r"]);
    expect(resizes).toEqual([[1, 1]]);
    expect(sent.at(-1)).toEqual([
      CH.terminalData,
      { id: "term-1", data: "output" },
    ]);

    onExit({ exitCode: 7 });
    expect(sent.at(-1)).toEqual([
      CH.terminalExit,
      { id: "term-1", code: 7 },
    ]);
    ipc.emit(CH.terminalWrite, created.id, "ignored");
    expect(writes).toHaveLength(1);

    const second = await ipc.invoke<TerminalCreated>(CH.terminalCreate, {});
    expect(second.id).toBe("term-2");
    expect(second.shell).toBe(
      process.platform === "win32"
        ? process.env.COMSPEC || "powershell.exe"
        : process.env.SHELL || "/bin/zsh",
    );
    expect(spawnArgs[2]).toMatchObject({ cols: 80, rows: 24 });
    ipc.emit(CH.terminalKill, second.id);
    expect(kills).toBe(1);
    cleanup();
  });

  it("kills remaining terminals during cleanup and tolerates process races", async () => {
    const ipc = createIpcHarness();
    let resizeCalls = 0;
    let killCalls = 0;
    let writeCalls = 0;
    const proc = {
      pid: 7,
      write: () => {
        writeCalls++;
      },
      resize: () => {
        resizeCalls++;
        throw new Error("already exited");
      },
      kill: () => {
        killCalls++;
        throw new Error("already exited");
      },
      onData: () => disposable(),
      onExit: () => disposable(),
    } as unknown as IPty;
    const cleanup = registerTerminalService(
      {
        ipcMain: ipc.ipcMain,
        userDataDir: "/tmp",
        getWindow: () => null,
        isTrustedSender: () => true,
        send: () => undefined,
      } satisfies ServiceContext,
      { spawn: () => proc } as unknown as typeof import("node-pty"),
    );
    const terminal = await ipc.invoke<TerminalCreated>(CH.terminalCreate, {
      shell: "/bin/test-shell",
    });

    ipc.emit(CH.terminalResize, terminal.id, 80, 24);
    expect(resizeCalls).toBe(1);
    expect(() => ipc.emit(CH.terminalKill, terminal.id)).toThrow(
      "already exited",
    );
    ipc.emit(CH.terminalWrite, terminal.id, "ignored");
    expect(writeCalls).toBe(0);

    await ipc.invoke<TerminalCreated>(CH.terminalCreate, {
      shell: "/bin/test-shell",
    });
    cleanup();
    expect(killCalls).toBe(2);
  });
});
