import { describe, expect, it } from "@lightning-js/lightning";
import type { DapArguments, DapResponse, DebugSessionInfo } from "../../shared/dap";
import type { ServiceContext } from "./context";
import { executeDebugControl } from "./debug-control";

function response<T>(command: string, body: T): DapResponse<T> {
  return {
    seq: 1,
    type: "response",
    request_seq: 1,
    success: true,
    command,
    body,
  };
}

function controller() {
  const session: DebugSessionInfo = {
    id: "debug-1",
    name: "Node",
    debugType: "node",
    request: "launch",
    status: "stopped",
    capabilities: {},
  };
  const requests: Array<{ sessionId: string; command: string; args?: DapArguments }> = [];
  const starts: unknown[] = [];
  const debug: NonNullable<ServiceContext["debug"]> = {
    list: () => [session],
    generation: () => "generation-1",
    start: async () => session,
    stop: async () => undefined,
    restart: async () => ({ ...session, status: "running" }),
    configurations: async () => ({
      path: "/workspace/.logos/launch.json",
      configurations: [{ name: "Node", type: "node", request: "launch" }],
    }),
    startConfiguration: async (...args) => {
      starts.push(args);
      return { ...session, status: "running" };
    },
    setBreakpoints: async (_sessionId, _sourcePath, breakpoints) =>
      breakpoints.map(item => ({ verified: true, line: item.line })),
    request: async <T = unknown>(sessionId: string, command: string, args?: DapArguments) => {
      requests.push({ sessionId, command, args });
      if (command === "threads") {
        return response(command, { threads: [{ id: 7, name: "main" }] }) as DapResponse<T>;
      }
      if (command === "stackTrace") {
        return response(command, { stackFrames: [{ id: 9, name: "main" }] }) as DapResponse<T>;
      }
      return response(command, { ok: true }) as DapResponse<T>;
    },
  };
  return { debug, requests, starts };
}

describe("debug control", () => {
  it("lists configurations and starts a named configuration", async () => {
    const { debug, starts } = controller();
    await expect(
      executeDebugControl(debug, "/workspace", { action: "list_configurations" }),
    ).resolves.toMatchObject({
      configurations: [{ name: "Node" }],
    });
    await expect(
      executeDebugControl(debug, "/workspace", {
        action: "start",
        configuration: "Node",
        active_file: "/workspace/src/app.ts",
      }),
    ).resolves.toMatchObject({ status: "running" });
    expect(starts[0]).toEqual([
      "/workspace",
      "Node",
      "/workspace/src/app.ts",
      undefined,
      undefined,
    ]);
  });

  it("maps execution and inspection actions to DAP requests", async () => {
    const { debug, requests } = controller();
    await executeDebugControl(debug, "/workspace", { action: "step_over" });
    await expect(
      executeDebugControl(debug, "/workspace", {
        action: "stack_trace",
        start_frame: 0,
        levels: 20,
      }),
    ).resolves.toMatchObject({ stackFrames: [{ id: 9 }] });
    expect(requests).toEqual([
      { sessionId: "debug-1", command: "threads", args: undefined },
      { sessionId: "debug-1", command: "next", args: { threadId: 7 } },
      { sessionId: "debug-1", command: "threads", args: undefined },
      {
        sessionId: "debug-1",
        command: "stackTrace",
        args: { threadId: 7, startFrame: 0, levels: 20 },
      },
    ]);
  });

  it("validates source paths and required variable references", async () => {
    const { debug } = controller();
    await expect(
      executeDebugControl(debug, "/workspace", {
        action: "set_breakpoints",
        source_path: "src/app.ts",
        breakpoints: [{ line: 1 }],
      }),
    ).rejects.toThrow("absolute workspace path");
    await expect(
      executeDebugControl(debug, "/workspace", { action: "variables" }),
    ).rejects.toThrow("variables_reference");
  });
});
