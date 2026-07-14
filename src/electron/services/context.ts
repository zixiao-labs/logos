import type { BrowserWindow, IpcMain } from "electron";
import type {
  TerminalCreateOptions,
  TerminalCreated,
} from "../../shared/types";

/**
 * Passed to every service's `register` function. Keeps services decoupled from
 * how the window is created while still letting them push events to the
 * renderer.
 */
export interface ServiceContext {
  ipcMain: IpcMain;
  /** Push an event to the focused renderer (no-op if the window is gone). */
  send(channel: string, ...args: unknown[]): void;
  getWindow(): BrowserWindow | null;
  /** Absolute path to Electron's per-user data directory. */
  userDataDir: string;
  /** Prevent development-only resources from shadowing signed packaged code. */
  isPackaged?: boolean;
  terminal?: {
    create(options: TerminalCreateOptions): TerminalCreated;
    kill(id: string): void;
  };
}
