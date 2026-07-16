import { afterEach, describe, expect, it } from "@lightning-js/lightning";
import type { AcpRegistryAgent } from "../shared/types";
import { type AgentThread, useStore } from "./store";

const initialStoreState = useStore.getInitialState();
const initialWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

afterEach(() => {
  useStore.setState(initialStoreState, true);
  if (initialWindowDescriptor) {
    Object.defineProperty(globalThis, "window", initialWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

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

    await useStore.getState().sendAgentPrompt("hello");
    const thread = useStore.getState().agentSessions[0];
    expect(thread.status).toBe("idle");
    expect(thread.items.at(-1)).toMatchObject({
      kind: "error",
      message: "start failed",
    });
  });

  it("does not duplicate an error event when agent start also rejects", async () => {
    let rejectStart!: (reason: Error) => void;
    const start = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { logos: { agent: { start: () => start } } },
    });
    useStore.setState({
      root: "/workspace",
      agentSessions: [agentThread()],
      activeAgentId: "agent",
    });

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
  });

  it("replaces a successful empty registry and preserves it on failure", async () => {
    const registryAgent: AcpRegistryAgent = {
      id: "agent",
      name: "Agent",
      description: "Test agent",
      version: "1.0.0",
      distributionKinds: ["npx"],
      available: true,
    };
    let fail = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          agent: {
            listRegistry: () =>
              fail ? Promise.reject(new Error("offline")) : Promise.resolve([]),
          },
        },
      },
    });
    useStore.setState({ agentRegistry: [registryAgent] });

    await useStore.getState().loadAgentRegistry();
    expect(useStore.getState().agentRegistry).toEqual([registryAgent]);

    fail = false;
    await useStore.getState().loadAgentRegistry();
    expect(useStore.getState().agentRegistry).toEqual([]);
  });
});
