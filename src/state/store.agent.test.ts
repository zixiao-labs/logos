import { describe, expect, it } from "@lightning-js/lightning";
import { type AgentThread, useStore } from "./store";

function agentThread(id = "agent"): AgentThread {
  return {
    id,
    name: "Agent",
    items: [],
    status: "idle",
    runtimeId: "claude",
    createdAt: 1,
    updatedAt: 1,
    followMode: true,
    plan: [],
    modes: [],
    models: [],
    configOptions: [],
    authMethods: [],
    commands: [],
    canConfigureProviders: false,
    trace: [],
  };
}

describe("agent store", () => {
  it("only joins relative follow paths to the workspace root", () => {
    const paths = [
      "C:\\",
      "C:\\repo\\file.ts",
      "D:/repo/file.ts",
      "\\repo\\file.ts",
      "\\\\server\\share\\file.ts",
      "\\\\?\\C:\\repo\\file.ts",
      "\\\\.\\pipe\\logos",
      "/tmp/file.ts",
    ];

    for (const path of paths) {
      useStore.setState({
        root: "C:\\workspace",
        tabs: [],
        activeTabId: null,
        agentSessions: [agentThread()],
        activeAgentId: "agent",
      });
      useStore.getState().applyAgentEvent({
        kind: "follow",
        sessionId: "agent",
        location: { path },
      });
      expect(useStore.getState().tabs[0]?.path).toBe(path);
    }

    useStore.getState().applyAgentEvent({
      kind: "follow",
      sessionId: "agent",
      location: { path: "src/file.ts" },
    });
    expect(useStore.getState().tabs.at(-1)?.path).toBe(
      "C:\\workspace/src/file.ts",
    );
  });

  it("returns a running session to idle when agent start rejects", async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          agent: {
            start: () => Promise.reject(new Error("start failed")),
          },
        },
      },
    });
    useStore.setState({
      root: "/workspace",
      agentSessions: [agentThread()],
      activeAgentId: "agent",
    });

    try {
      await useStore.getState().sendAgentPrompt("hello");
      const thread = useStore.getState().agentSessions[0];
      expect(thread.status).toBe("idle");
      expect(thread.items.at(-1)).toMatchObject({
        kind: "error",
        message: "start failed",
      });
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("does not duplicate an error event when agent start also rejects", async () => {
    let rejectStart!: (reason: Error) => void;
    const start = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { logos: { agent: { start: () => start } } },
    });
    useStore.setState({
      root: "/workspace",
      agentSessions: [agentThread()],
      activeAgentId: "agent",
    });

    try {
      const sending = useStore.getState().sendAgentPrompt("hello");
      useStore.getState().applyAgentEvent({
        kind: "error",
        sessionId: "agent",
        message: "main process failed",
      });
      rejectStart(new Error("start failed"));
      await sending;

      const errors = useStore
        .getState()
        .agentSessions[0].items.filter((item) => item.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: "main process failed" });
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
