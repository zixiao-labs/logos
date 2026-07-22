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
  DapBreakpoint,
  DapResponse,
  DapSourceBreakpoint,
  DebugSessionInfo,
  DebugStartRequest,
  DebugLaunchConfiguration,
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
  /** Bundled stdio MCP entry used by workspace auto-configuration. */
  debugMcpServerPath?: string;
  /** Trusted project-skill templates copied only after explicit user opt-in. */
  agentSkillsDir?: string;
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
    start(request: DebugStartRequest): Promise<DebugSessionInfo>;
    stop(sessionId: string, terminateDebuggee?: boolean): Promise<void>;
    restart(sessionId: string): Promise<DebugSessionInfo>;
    configurations(workspaceRoot: string): Promise<{
      path: string | null;
      configurations: DebugLaunchConfiguration[];
    }>;
    startConfiguration(
      workspaceRoot: string,
      name?: string,
      activeFile?: string,
      initialBreakpoints?: Record<string, DapSourceBreakpoint[]>,
      expectedConfigurationFingerprint?: string,
    ): Promise<DebugSessionInfo>;
    setBreakpoints(
      sessionId: string,
      sourcePath: string,
      breakpoints: DapSourceBreakpoint[],
    ): Promise<DapBreakpoint[]>;
    request<T = unknown>(
      sessionId: string,
      command: string,
      args?: DapArguments,
    ): Promise<DapResponse<T>>;
  };
}
