import { afterEach, describe, expect, it } from "@lightning-js/lightning";
import type {
  AcpRegistryAgent,
  WorkspaceAgentSetupStatus,
} from "../shared/types";
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

function workspaceAgentPrompt(root: string): WorkspaceAgentSetupStatus {
  return {
    root,
    mcp: { mcpJson: false, cursor: false, vscode: false, codex: false },
    skill: false,
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

describe("workspace Agent setup store", () => {
  it("clears the setup prompt when the workspace changes", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          workspace: {
            setRoot: async () => undefined,
            getFolders: async () => ["/next"],
            recent: async () => [],
            addFolder: async () => ({
              root: "/next",
              folders: ["/next", "/second"],
            }),
            removeFolder: async () => ({
              root: "/second",
              folders: ["/second"],
            }),
          },
          git: { watch: async () => undefined },
        },
      },
    });
    useStore.setState({
      workspaceAgentSetup: workspaceAgentPrompt("/old"),
      refreshGit: async () => undefined,
      loadDebugConfigurations: async () => undefined,
    });

    await useStore.getState().setRoot("/next");
    expect(useStore.getState().workspaceAgentSetup).toBeNull();

    useStore.setState({ workspaceAgentSetup: workspaceAgentPrompt("/next") });
    await useStore.getState().addWorkspaceFolder();
    expect(useStore.getState().workspaceAgentSetup).toBeNull();

    useStore.setState({ workspaceAgentSetup: workspaceAgentPrompt("/next") });
    await useStore.getState().removeWorkspaceFolder("/next");
    expect(useStore.getState().workspaceAgentSetup).toBeNull();
  });

  it("keeps a successful folder switch when setup status lookup fails", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          dialog: { openFolder: async () => "/next" },
          workspace: {
            setRoot: async () => undefined,
            getFolders: async () => ["/next"],
            recent: async () => [],
            agentSetupStatus: async () => {
              throw new Error("status failed");
            },
          },
          git: { watch: async () => undefined },
        },
      },
    });
    useStore.setState({
      recent: [],
      refreshGit: async () => undefined,
      loadDebugConfigurations: async () => undefined,
    });

    await expect(useStore.getState().openFolder()).resolves.toBeUndefined();
    expect(useStore.getState().root).toBe("/next");
    expect(useStore.getState().workspaceAgentSetup).toBeNull();
  });

  it("does not apply a setup prompt from a stale workspace", async () => {
    let setupCalls = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        logos: {
          workspace: {
            setupAgents: async () => {
              setupCalls++;
            },
          },
        },
      },
    });
    useStore.setState({
      root: "/current",
      workspaceAgentSetup: workspaceAgentPrompt("/old"),
    });

    await useStore.getState().setupWorkspaceAgents(true, true);

    expect(setupCalls).toBe(0);
    expect(useStore.getState().workspaceAgentSetup).toBeNull();
  });
});
