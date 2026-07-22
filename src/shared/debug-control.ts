import type { DapArguments, DapSourceBreakpoint } from "./dap";

export const DEBUG_CONTROL_ACTIONS = [
  "list_configurations",
  "list_sessions",
  "start",
  "stop",
  "restart",
  "continue",
  "pause",
  "step_over",
  "step_in",
  "step_out",
  "set_breakpoints",
  "threads",
  "stack_trace",
  "scopes",
  "variables",
  "evaluate",
  "source",
  "request",
] as const;

export type DebugControlAction = (typeof DEBUG_CONTROL_ACTIONS)[number];

export interface DebugMcpApprovalRequest {
  requestId: string;
  requestedAt: number;
  details: Record<string, unknown>;
}

export interface DebugMcpApprovalResponse {
  requestId: string;
  approved: boolean;
}

/** Shared control contract used by the built-in Agent and the MCP bridge. */
export interface DebugControlInput extends Record<string, unknown> {
  action: DebugControlAction;
  workspace?: string;
  configuration?: string;
  active_file?: string;
  session_id?: string;
  terminate_debuggee?: boolean;
  thread_id?: number;
  frame_id?: number;
  start_frame?: number;
  levels?: number;
  variables_reference?: number;
  start?: number;
  count?: number;
  filter?: "indexed" | "named";
  source_path?: string;
  breakpoints?: DapSourceBreakpoint[];
  expression?: string;
  context?: "watch" | "repl" | "hover" | "clipboard" | "variables";
  source_reference?: number;
  command?: string;
  arguments?: DapArguments;
  /** Internal approval fingerprint; never exposed in an Agent or MCP schema. */
  configuration_fingerprint?: string;
}

const READ_ONLY_ACTIONS = new Set<DebugControlAction>([
  "list_configurations",
  "list_sessions",
  "threads",
  "stack_trace",
  "scopes",
  "variables",
  "source",
]);

export function isDebugControlMutation(action: DebugControlAction): boolean {
  return !READ_ONLY_ACTIONS.has(action);
}

export function isDebugControlAction(value: unknown): value is DebugControlAction {
  return typeof value === "string" &&
    (DEBUG_CONTROL_ACTIONS as readonly string[]).includes(value);
}
