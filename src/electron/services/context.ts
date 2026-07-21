import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import type {
  TerminalCreateOptions,
  TerminalCreated,
} from "../../shared/types";
import type {
  DapArguments,
  DapResponse,
  DebugSessionInfo,
} from "../../shared/dap";
import type { WorkspaceAccessController } from "./workspace-access";
import type { IpcRegistration } from "./ipc-security";

/**
 * Passed to every service's `register` function. Keeps services decoupled from
 * how the window is created while still letting them push events to the
 * renderer.
 */
export interface ServiceContext {
  ipcMain: IpcRegistration;
  /** Push an event to the focused renderer (no-op if the window is gone). */
  send(channel: string, ...args: unknown[]): void;
  getWindow(): BrowserWindow | null;
  /** Absolute path to Electron's per-user data directory. */
  userDataDir: string;
  /** Prevent development-only resources from shadowing signed packaged code. */
  isPackaged?: boolean;
  /** Product version used to enforce manifest engine compatibility. */
  appVersion?: string;
  /** Development-only, read-only extension registry root. */
  extensionRegistryDir?: string;
  /** Runtime supplies this to bind privileged invokes to the workbench main frame. */
  isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean;
  /** Main-process authority for workspace and native-dialog file grants. */
  workspaceAccess?: WorkspaceAccessController;
  terminal?: {
    create(options: TerminalCreateOptions): TerminalCreated;
    kill(id: string): void;
  };
  debug?: {
    list(): DebugSessionInfo[];
    generation(sessionId: string): string | undefined;
    request<T = unknown>(
      sessionId: string,
      command: string,
      args?: DapArguments,
    ): Promise<DapResponse<T>>;
  };
}
