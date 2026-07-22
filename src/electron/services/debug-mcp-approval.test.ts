import { describe, expect, it } from "@lightning-js/lightning";
import { CH } from "../../shared/channels";
import { createIpcHarness } from "../../test/ipc-harness";
import type { ServiceContext } from "./context";
import { registerDebugMcpApprovalService } from "./debug-mcp-approval";

describe("debug MCP approval service", () => {
  it("queues renderer approvals and resolves an explicit response", async () => {
    const ipc = createIpcHarness();
    const sent: Array<[string, ...unknown[]]> = [];
    const notifications: unknown[] = [];
    const ctx = {
      ipcMain: ipc.ipcMain,
      userDataDir: "/tmp/logos-test",
      getWindow: () => ({ isDestroyed: () => false }),
      isTrustedSender: () => true,
      send: (channel: string, ...args: unknown[]) => sent.push([channel, ...args]),
    } as unknown as ServiceContext;
    const service = registerDebugMcpApprovalService(ctx, request => {
      notifications.push(request);
    });

    const decision = service.request({ action: "start", configuration: "Node" });
    const queued = await ipc.invoke<Array<{ requestId: string }>>(
      CH.debugMcpPendingApprovals,
    );
    expect(queued).toHaveLength(1);
    expect(sent[0]).toEqual([
      CH.debugMcpApprovalRequest,
      expect.objectContaining({ details: { action: "start", configuration: "Node" } }),
    ]);
    expect(notifications).toHaveLength(1);

    await ipc.invoke(CH.debugMcpRespondApproval, {
      requestId: queued[0].requestId,
      approved: true,
    });
    expect(await decision).toBe(true);
    expect(await ipc.invoke(CH.debugMcpPendingApprovals)).toEqual([]);
    service.dispose();
  });

  it("denies immediately when the workbench window is unavailable", async () => {
    const ipc = createIpcHarness();
    const ctx = {
      ipcMain: ipc.ipcMain,
      userDataDir: "/tmp/logos-test",
      getWindow: () => null,
      isTrustedSender: () => true,
      send: () => undefined,
    } as unknown as ServiceContext;
    const service = registerDebugMcpApprovalService(ctx);
    expect(await service.request({ action: "evaluate" })).toBe(false);
    service.dispose();
  });
});
