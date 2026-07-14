import { describe, expect, it } from "@lightning-js/lightning";
import type { DapResponse, DebugSessionInfo } from "../shared/dap";
import { useStore } from "./store";

function session(id: string, status: DebugSessionInfo["status"]): DebugSessionInfo {
  return {
    id,
    name: id,
    debugType: "custom",
    request: "launch",
    status,
    capabilities: {},
  };
}

function setPausedDebugState() {
  useStore.setState((state) => ({
    debug: {
      ...state.debug,
      sessions: {
        a: session("a", "stopped"),
        b: session("b", "running"),
      },
      activeSessionId: "a",
      pausedSessionId: "a",
      pauseGeneration: 1,
      threads: [
        { id: 1, name: "one" },
        { id: 2, name: "two" },
      ],
      selectedThreadId: 1,
      stackFrames: [{ id: 10, name: "frame", line: 1, column: 1 }],
      selectedFrameId: 10,
      scopes: [],
      variables: {},
      stoppedReason: "breakpoint",
    },
  }));
}

describe("debug store state isolation", () => {
  it("ignores continued events from a background session", () => {
    setPausedDebugState();

    useStore.getState().applyDebugEvent({
      kind: "dap",
      sessionId: "b",
      event: {
        seq: 1,
        type: "event",
        event: "continued",
        body: { threadId: 20, allThreadsContinued: true },
      },
    });

    expect(useStore.getState().debug.stackFrames).toHaveLength(1);
    expect(useStore.getState().debug.pausedSessionId).toBe("a");
  });

  it("keeps the selected thread when a different thread continues", () => {
    setPausedDebugState();

    useStore.getState().applyDebugEvent({
      kind: "dap",
      sessionId: "a",
      event: {
        seq: 1,
        type: "event",
        event: "continued",
        body: { threadId: 2, allThreadsContinued: false },
      },
    });

    expect(useStore.getState().debug.selectedThreadId).toBe(1);
    expect(useStore.getState().debug.stackFrames).toHaveLength(1);
  });

  it("drops a threads response after another session takes focus", async () => {
    setPausedDebugState();
    let resolveThreads!: (response: DapResponse<{ threads?: Array<{ id: number; name: string }> }>) => void;
    const threads = new Promise<DapResponse<{ threads?: Array<{ id: number; name: string }> }>>(
      (resolve) => {
        resolveThreads = resolve;
      },
    );
    const requests: Array<{ sessionId: string; command: string }> = [];
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            request: (sessionId: string, command: string) => {
              requests.push({ sessionId, command });
              return threads;
            },
          },
        },
      },
    });

    try {
      useStore.getState().applyDebugEvent({
        kind: "dap",
        sessionId: "a",
        event: {
          seq: 1,
          type: "event",
          event: "stopped",
          body: { reason: "breakpoint", threadId: 1 },
        },
      });
      useStore.setState((state) => ({
        debug: {
          ...state.debug,
          activeSessionId: "b",
          pausedSessionId: "b",
          pauseGeneration: state.debug.pauseGeneration + 1,
          threads: [],
        },
      }));
      resolveThreads({
        seq: 2,
        type: "response",
        request_seq: 1,
        command: "threads",
        success: true,
        body: { threads: [{ id: 1, name: "stale" }] },
      });
      await threads;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(useStore.getState().debug.threads).toEqual([]);
      expect(requests).toEqual([{ sessionId: "a", command: "threads" }]);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("ignores an older setBreakpoints response", async () => {
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        sessions: { a: session("a", "running") },
        activeSessionId: "a",
        breakpoints: {},
      },
    }));
    const resolvers: Array<(value: Array<{ verified: boolean; line?: number }>) => void> = [];
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            setBreakpoints: () =>
              new Promise<Array<{ verified: boolean; line?: number }>>(
                (resolve) => resolvers.push(resolve),
              ),
          },
        },
      },
    });

    try {
      const add = useStore.getState().toggleBreakpoint("/workspace/app.js", 7);
      useStore.setState((state) => ({
        debug: {
          ...state.debug,
          sessions: {
            ...state.debug.sessions,
            b: session("b", "running"),
          },
          activeSessionId: "b",
        },
      }));
      const remove = useStore.getState().toggleBreakpoint("/workspace/app.js", 7);
      resolvers[1]([]);
      await remove;
      resolvers[0]([{ verified: true, line: 9 }]);
      await add;

      expect(useStore.getState().debug.breakpoints["/workspace/app.js"]).toEqual(
        [],
      );
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("matches breakpoint changes and removals by adapter id", () => {
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        sessions: { a: session("a", "stopped") },
        activeSessionId: "a",
        breakpoints: {
          "/workspace/app.js": [
            {
              id: "local-1",
              line: 7,
              sessionData: {
                a: { id: 42, verified: false, line: 9 },
              },
            },
          ],
        },
      },
    }));

    useStore.getState().applyDebugEvent({
      kind: "dap",
      sessionId: "a",
      event: {
        seq: 1,
        type: "event",
        event: "breakpoint",
        body: {
          reason: "changed",
          breakpoint: { id: 42, verified: true, message: "resolved" },
        },
      },
    });
    expect(
      useStore.getState().debug.breakpoints["/workspace/app.js"][0].sessionData
        ?.a,
    ).toMatchObject({ id: 42, verified: true, message: "resolved" });

    useStore.getState().applyDebugEvent({
      kind: "dap",
      sessionId: "a",
      event: {
        seq: 2,
        type: "event",
        event: "breakpoint",
        body: {
          reason: "removed",
          breakpoint: { id: 42, verified: false },
        },
      },
    });
    expect(useStore.getState().debug.breakpoints["/workspace/app.js"]).toEqual(
      [],
    );
  });

  it("keeps adapter-created breakpoints transient and out of client requests", async () => {
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        sessions: { a: session("a", "stopped") },
        activeSessionId: "a",
        breakpoints: {
          "/workspace/app.js": [
            {
              id: "adapter-breakpoint",
              line: 7,
              adapterCreated: true,
              sessionData: { a: { id: 42, verified: true, line: 7 } },
            },
          ],
        },
      },
    }));
    useStore.getState().applyDebugEvent({
      kind: "session",
      session: session("a", "running"),
    });
    expect(useStore.getState().debug.breakpoints["/workspace/app.js"]).toHaveLength(
      1,
    );

    let requested: unknown;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            setBreakpoints: (
              _sessionId: string,
              _sourcePath: string,
              breakpoints: unknown,
            ) => {
              requested = breakpoints;
              return Promise.resolve([{ verified: true, line: 8 }]);
            },
          },
        },
      },
    });

    try {
      await useStore.getState().toggleBreakpoint("/workspace/app.js", 8);
      expect(requested).toEqual([{ line: 8 }]);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("pages large indexed variable collections", async () => {
    setPausedDebugState();
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        selectedFrameId: 10,
        scopes: [
          {
            name: "Array",
            variablesReference: 5,
            namedVariables: 0,
            indexedVariables: 250,
            expensive: false,
          },
        ],
        variables: {},
      },
    }));
    const requests: Array<Record<string, unknown> | undefined> = [];
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            request: (
              _sessionId: string,
              _command: string,
              args?: Record<string, unknown>,
            ) => {
              requests.push(args);
              return Promise.resolve({
                seq: 2,
                type: "response",
                request_seq: 1,
                command: "variables",
                success: true,
                body: {
                  variables: [
                    { name: "0", value: "first", variablesReference: 0 },
                  ],
                },
              });
            },
          },
        },
      },
    });

    try {
      await useStore.getState().loadDebugVariables(5);
      const pages = useStore.getState().debug.variables[5];
      expect(pages).toHaveLength(3);
      expect(requests).toEqual([]);

      await useStore
        .getState()
        .loadDebugVariables(pages[0].variablesReference);
      expect(requests[0]).toMatchObject({
        variablesReference: 5,
        filter: "indexed",
        start: 0,
        count: 100,
      });
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("requests named variables when the adapter omits their count", async () => {
    setPausedDebugState();
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        scopes: [
          {
            name: "Object",
            variablesReference: 6,
            indexedVariables: 0,
            expensive: false,
          },
        ],
        variables: {},
      },
    }));
    let requestArguments: Record<string, unknown> | undefined;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            request: (
              _sessionId: string,
              _command: string,
              args?: Record<string, unknown>,
            ) => {
              requestArguments = args;
              return Promise.resolve({
                body: {
                  variables: [
                    { name: "property", value: "value", variablesReference: 0 },
                  ],
                },
              });
            },
          },
        },
      },
    });

    try {
      await useStore.getState().loadDebugVariables(6);
      expect(requestArguments).toMatchObject({
        variablesReference: 6,
        filter: "named",
      });
      expect(useStore.getState().debug.variables[6]).toMatchObject([
        { name: "property", value: "value" },
      ]);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("recursively pages large named variable collections", async () => {
    setPausedDebugState();
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        scopes: [
          {
            name: "Large object",
            variablesReference: 7,
            namedVariables: 100_000,
            expensive: false,
          },
        ],
        variables: {},
      },
    }));
    const requests: Array<Record<string, unknown> | undefined> = [];
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            request: (
              _sessionId: string,
              _command: string,
              args?: Record<string, unknown>,
            ) => {
              requests.push(args);
              return Promise.resolve({ body: { variables: [] } });
            },
          },
        },
      },
    });

    try {
      await useStore.getState().loadDebugVariables(7);
      const topPages = useStore.getState().debug.variables[7];
      expect(topPages).toHaveLength(10);
      expect(requests).toEqual([]);

      await useStore
        .getState()
        .loadDebugVariables(topPages[0].variablesReference);
      const leafPages =
        useStore.getState().debug.variables[topPages[0].variablesReference];
      expect(leafPages).toHaveLength(100);
      expect(requests).toEqual([]);

      await useStore
        .getState()
        .loadDebugVariables(leafPages[0].variablesReference);
      expect(requests[0]).toMatchObject({
        variablesReference: 7,
        filter: "named",
        start: 0,
        count: 100,
      });
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("detaches attach sessions instead of terminating their debuggee", async () => {
    useStore.setState((state) => ({
      debug: {
        ...state.debug,
        sessions: {
          attached: {
            ...session("attached", "running"),
            request: "attach",
          },
        },
        activeSessionId: "attached",
      },
    }));
    let stopArguments: [string, boolean | undefined] | undefined;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          debug: {
            stop: (sessionId: string, terminateDebuggee?: boolean) => {
              stopArguments = [sessionId, terminateDebuggee];
              return Promise.resolve();
            },
          },
        },
      },
    });

    try {
      await useStore.getState().stopDebug();
      expect(stopArguments).toEqual(["attached", false]);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
