import path from "node:path";
import type {
  DapArguments,
  DapResponse,
  DebugSessionInfo,
} from "../../shared/dap";
import {
  isDebugControlMutation,
  type DebugControlInput,
} from "../../shared/debug-control";
import type { ServiceContext } from "./context";

type DebugController = NonNullable<ServiceContext["debug"]>;

function responseBody<T>(response: DapResponse<T>): T | Record<string, never> {
  if (!response.success) throw new Error(response.message ?? "DAP request failed");
  return response.body ?? {};
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return Number(value);
}

export function activeSession(controller: DebugController, requested?: string): DebugSessionInfo {
  const sessions = controller.list().filter(
    session => session.status !== "terminating" && session.status !== "terminated" && session.status !== "error",
  );
  const id = requested?.trim();
  const session = id
    ? sessions.find(candidate => candidate.id === id)
    : sessions.length === 1
      ? sessions[0]
      : undefined;
  if (session) return session;
  const available = sessions.map(item => `${item.id} (${item.name})`).join(", ");
  throw new Error(
    id
      ? `Debug session '${id}' is not active${available ? `; available: ${available}` : ""}`
      : sessions.length === 0
        ? "No active debug session"
        : `Multiple debug sessions are active; choose session_id: ${available}`,
  );
}

export interface DebugControlMutationApproval {
  action: DebugControlInput["action"];
  generation: string;
  session?: DebugSessionInfo;
  configurationPath?: string | null;
  configurationDetails?: unknown;
}

export async function prepareDebugControlMutationApproval(
  controller: DebugController,
  defaultWorkspace: string,
  input: DebugControlInput,
): Promise<DebugControlMutationApproval> {
  if (!isDebugControlMutation(input.action)) {
    throw new Error(`Debug action '${input.action}' does not require approval`);
  }
  if (input.action === "start") {
    const listed = await controller.configurations(input.workspace || defaultWorkspace);
    const selected = input.configuration
      ? listed.configurations.find(item => item.name === input.configuration)
      : listed.configurations.length === 1
        ? listed.configurations[0]
        : undefined;
    if (!selected) {
      const available = listed.configurations.map(item => item.name).join(", ");
      throw new Error(
        input.configuration
          ? `Debug configuration '${input.configuration}' was not found${available ? `; available: ${available}` : ""}`
          : listed.configurations.length === 0
            ? "No launch configurations are available"
            : `Multiple launch configurations are available; choose configuration: ${available}`,
      );
    }
    return {
      action: input.action,
      generation: JSON.stringify({ path: listed.path, configuration: selected }),
      configurationPath: listed.path,
      configurationDetails: selected,
    };
  }

  const session = activeSession(controller, String(input.session_id ?? ""));
  const generation = controller.generation(session.id);
  if (!generation) throw new Error(`Debug session '${session.id}' is not active`);
  return { action: input.action, generation, session };
}

export function applyDebugControlMutationApproval(
  controller: DebugController,
  input: DebugControlInput,
  approval: DebugControlMutationApproval,
): DebugControlInput {
  if (input.action !== approval.action) throw new Error("The debug action was not approved");
  if (input.action === "start") {
    return { ...input, configuration_fingerprint: approval.generation };
  }
  if (
    !approval.session ||
    controller.generation(approval.session.id) !== approval.generation
  ) {
    throw new Error("The debug session changed after approval; review and approve it again");
  }
  return { ...input, session_id: approval.session.id };
}

async function threadId(
  controller: DebugController,
  session: DebugSessionInfo,
  requested: unknown,
): Promise<number> {
  if (Number.isInteger(requested)) return Number(requested);
  const response = await controller.request<{ threads?: Array<{ id: number }> }>(
    session.id,
    "threads",
  );
  const first = responseBody(response).threads?.[0]?.id;
  if (!Number.isInteger(first)) throw new Error("The debug session has no threads");
  return first!;
}

/** Execute one high-level or raw DAP operation against the shared Logos debugger. */
export async function executeDebugControl(
  controller: DebugController,
  defaultWorkspace: string,
  input: DebugControlInput,
): Promise<unknown> {
  switch (input.action) {
    case "list_configurations":
      return controller.configurations(input.workspace || defaultWorkspace);
    case "list_sessions":
      return controller.list();
    case "start":
      if (Array.isArray(input.breakpoints) && !String(input.source_path ?? "").trim()) {
        throw new Error("source_path is required when start includes breakpoints");
      }
      return controller.startConfiguration(
        input.workspace || defaultWorkspace,
        typeof input.configuration === "string" ? input.configuration : undefined,
        typeof input.active_file === "string" ? input.active_file : undefined,
        Array.isArray(input.breakpoints)
          ? { [String(input.source_path ?? "")]: input.breakpoints }
          : undefined,
        input.configuration_fingerprint,
      );
    case "stop": {
      const session = activeSession(controller, input.session_id);
      await controller.stop(
        session.id,
        input.terminate_debuggee ?? session.request === "launch",
      );
      return { stopped: session.id };
    }
    case "restart": {
      const session = activeSession(controller, input.session_id);
      return controller.restart(session.id);
    }
  }

  const session = activeSession(controller, input.session_id);
  switch (input.action) {
    case "continue":
    case "pause":
    case "step_over":
    case "step_in":
    case "step_out": {
      const command = {
        continue: "continue",
        pause: "pause",
        step_over: "next",
        step_in: "stepIn",
        step_out: "stepOut",
      }[input.action];
      const response = await controller.request(
        session.id,
        command,
        { threadId: await threadId(controller, session, input.thread_id) },
      );
      return responseBody(response);
    }
    case "set_breakpoints": {
      const sourcePath = String(input.source_path ?? "").trim();
      if (!sourcePath || !path.isAbsolute(sourcePath)) {
        throw new Error("source_path must be an absolute workspace path");
      }
      if (!Array.isArray(input.breakpoints)) throw new Error("breakpoints must be an array");
      return controller.setBreakpoints(session.id, sourcePath, input.breakpoints);
    }
    case "threads":
      return responseBody(await controller.request(session.id, "threads"));
    case "stack_trace": {
      const args: DapArguments = {
        threadId: await threadId(controller, session, input.thread_id),
      };
      if (input.start_frame !== undefined) args.startFrame = integer(input.start_frame, "start_frame");
      if (input.levels !== undefined) args.levels = integer(input.levels, "levels", 1);
      return responseBody(await controller.request(session.id, "stackTrace", args));
    }
    case "scopes":
      return responseBody(await controller.request(session.id, "scopes", {
        frameId: integer(input.frame_id, "frame_id"),
      }));
    case "variables": {
      const args: DapArguments = {
        variablesReference: integer(input.variables_reference, "variables_reference", 1),
      };
      if (input.start !== undefined) args.start = integer(input.start, "start");
      if (input.count !== undefined) args.count = integer(input.count, "count", 1);
      if (input.filter) args.filter = input.filter;
      return responseBody(await controller.request(session.id, "variables", args));
    }
    case "evaluate": {
      const expression = String(input.expression ?? "").trim();
      if (!expression) throw new Error("expression is required");
      return responseBody(await controller.request(session.id, "evaluate", {
        expression,
        context: input.context ?? "repl",
        ...(Number.isInteger(input.frame_id) ? { frameId: input.frame_id } : {}),
      }));
    }
    case "source":
      return responseBody(
        await controller.source(
          session.id,
          integer(input.source_reference, "source_reference"),
          typeof input.source_path === "string" && input.source_path.trim()
            ? input.source_path
            : undefined,
        ),
      );
    case "request": {
      const command = String(input.command ?? "").trim();
      if (!command) throw new Error("command is required");
      // These carry workspace paths and have dedicated actions that bind them
      // to the workspace authority. Allowing them here would reopen that gap.
      if (command === "source" || command === "setBreakpoints") {
        throw new Error(
          `Use the '${command === "source" ? "source" : "set_breakpoints"}' action instead of a raw ${command} request`,
        );
      }
      return responseBody(await controller.request(
        session.id,
        command,
        input.arguments && typeof input.arguments === "object" ? input.arguments : undefined,
      ));
    }
    default:
      throw new Error(`Unsupported debug action: ${String(input.action)}`);
  }
}
