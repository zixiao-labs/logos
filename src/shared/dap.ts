import type { TerminalCreated } from "./types";

/**
 * Debug Adapter Protocol (DAP) data shared by the main process, preload and UI.
 *
 * The transport deliberately remains command-agnostic: adapters may add custom
 * requests, events and fields without requiring a Logos release. The named
 * interfaces below cover the protocol surface used by the built-in debugger UI.
 */

export type DapArguments = Record<string, unknown>;

export interface DapProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
}

export interface DapRequest extends DapProtocolMessage {
  type: "request";
  command: string;
  arguments?: DapArguments;
}

export interface DapResponse<T = unknown> extends DapProtocolMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: T;
}

export interface DapEvent<T = unknown> extends DapProtocolMessage {
  type: "event";
  event: string;
  body?: T;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface DapChecksum {
  algorithm: "MD5" | "SHA1" | "SHA256" | "timestamp";
  checksum: string;
}

export interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: "normal" | "emphasize" | "deemphasize";
  origin?: string;
  sources?: DapSource[];
  adapterData?: unknown;
  checksums?: DapChecksum[];
}

export interface DapSourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: DapSource;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  instructionReference?: string;
  offset?: number;
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  canRestart?: boolean;
  instructionPointerReference?: string;
  moduleId?: number | string;
  presentationHint?: "normal" | "label" | "subtle";
}

export interface DapScope {
  name: string;
  presentationHint?: "arguments" | "locals" | "registers" | string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
  source?: DapSource;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  presentationHint?: {
    kind?: "property" | "method" | "class" | "data" | "event" | "baseClass" | "innerClass" | "interface" | "mostDerivedClass" | "virtual" | "dataBreakpoint";
    attributes?: Array<"static" | "constant" | "readOnly" | "rawString" | "hasObjectId" | "canHaveObjectId" | "hasSideEffects" | "hasDataBreakpoint">;
    visibility?: "public" | "private" | "protected" | "internal" | "final";
    lazy?: boolean;
  };
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
  declarationLocationReference?: number;
  valueLocationReference?: number;
}

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  exceptionBreakpointFilters?: Array<{
    filter: string;
    label: string;
    description?: string;
    default?: boolean;
    supportsCondition?: boolean;
    conditionDescription?: string;
  }>;
  supportsStepBack?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartFrame?: boolean;
  supportsGotoTargetsRequest?: boolean;
  supportsStepInTargetsRequest?: boolean;
  supportsCompletionsRequest?: boolean;
  completionTriggerCharacters?: string[];
  supportsModulesRequest?: boolean;
  supportsRestartRequest?: boolean;
  supportsExceptionOptions?: boolean;
  supportsValueFormattingOptions?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportTerminateDebuggee?: boolean;
  supportSuspendDebuggee?: boolean;
  supportsDelayedStackTraceLoading?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsLogPoints?: boolean;
  supportsTerminateThreadsRequest?: boolean;
  supportsSetExpression?: boolean;
  supportsTerminateRequest?: boolean;
  supportsDataBreakpoints?: boolean;
  supportsReadMemoryRequest?: boolean;
  supportsWriteMemoryRequest?: boolean;
  supportsDisassembleRequest?: boolean;
  supportsCancelRequest?: boolean;
  supportsBreakpointLocationsRequest?: boolean;
  supportsClipboardContext?: boolean;
  supportsSteppingGranularity?: boolean;
  supportsInstructionBreakpoints?: boolean;
  supportsSingleThreadExecutionRequests?: boolean;
  supportsANSIStyling?: boolean;
  [key: string]: unknown;
}

export interface DapStoppedEventBody {
  reason: string;
  description?: string;
  threadId?: number;
  preserveFocusHint?: boolean;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
}

export interface DapContinuedEventBody {
  threadId: number;
  allThreadsContinued?: boolean;
}

export interface DapOutputEventBody {
  category?: "console" | "important" | "stdout" | "stderr" | "telemetry";
  output: string;
  group?: "start" | "startCollapsed" | "end";
  variablesReference?: number;
  source?: DapSource;
  line?: number;
  column?: number;
  data?: unknown;
  locationReference?: number;
}

export interface DapEvaluateResult {
  result: string;
  type?: string;
  presentationHint?: DapVariable["presentationHint"];
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
  valueLocationReference?: number;
}

export interface DebugAdapterExecutable {
  type: "executable";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | null>;
}

export interface DebugAdapterServer {
  type: "server";
  port: number;
  host?: string;
}

/** Launch an adapter process that exposes DAP over TCP instead of stdio. */
export interface DebugAdapterExecutableServer {
  type: "executable-server";
  command: string;
  /** `${port}` and `${host}` are replaced; if `${port}` is absent it is appended. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  host?: string;
  port?: number;
}

export type DebugAdapterDescriptor =
  | DebugAdapterExecutable
  | DebugAdapterServer
  | DebugAdapterExecutableServer;

/** A launch.json-compatible debug configuration plus a Logos adapter descriptor. */
export interface DebugLaunchConfiguration {
  name: string;
  type: string;
  request: "launch" | "attach";
  /**
   * Explicit adapter transport. Optional for built-in debugger types such as
   * node/chrome/electron once their packaged adapter is available.
   */
  adapter?: DebugAdapterDescriptor;
  [key: string]: unknown;
}

export interface DebugAdapterInfo {
  type: string;
  label: string;
  builtIn: boolean;
  available: boolean;
  message?: string;
}

export interface DebugConfigurationFile {
  version: "0.2.0" | string;
  configurations: DebugLaunchConfiguration[];
}

export interface DebugStartRequest {
  sessionId?: string;
  configuration: DebugLaunchConfiguration;
  initialBreakpoints?: Record<string, DapSourceBreakpoint[]>;
  exceptionBreakpoints?: string[];
}

export type DebugSessionStatus =
  | "initializing"
  | "starting"
  | "running"
  | "stopped"
  | "terminating"
  | "terminated"
  | "error";

export interface DebugSessionInfo {
  id: string;
  parentSessionId?: string;
  name: string;
  debugType: string;
  request: "launch" | "attach";
  status: DebugSessionStatus;
  capabilities: DapCapabilities;
  message?: string;
}

export type DebugSessionEvent =
  | { kind: "session"; session: DebugSessionInfo }
  | { kind: "dap"; sessionId: string; event: DapEvent }
  | {
      kind: "breakpoints";
      sessionId: string;
      sourcePath: string;
      requestedBreakpoints: DapSourceBreakpoint[];
      breakpoints: DapBreakpoint[];
    }
  | {
      kind: "terminal";
      sessionId: string;
      terminal: TerminalCreated;
      title?: string;
    }
  | { kind: "adapter-output"; sessionId: string; category: "stdout" | "stderr"; output: string };

export interface DebugBreakpointState extends DapSourceBreakpoint {
  id: string;
  sessionData?: Record<string, DapBreakpoint>;
  adapterCreated?: boolean;
}

export interface DebugConsoleEntry {
  id: string;
  category: "console" | "important" | "stdout" | "stderr" | "telemetry" | "input" | "result" | "error";
  output: string;
  source?: DapSource;
  line?: number;
  column?: number;
  variablesReference?: number;
}
