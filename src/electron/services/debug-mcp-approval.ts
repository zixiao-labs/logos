import { randomUUID } from "node:crypto";
import { CH } from "../../shared/channels";
import type {
  DebugMcpApprovalRequest,
  DebugMcpApprovalResponse,
} from "../../shared/debug-control";
import type { ServiceContext } from "./context";

const APPROVAL_TIMEOUT_MS = 60_000;
const MAX_PENDING_APPROVALS = 16;

interface PendingApproval {
  request: DebugMcpApprovalRequest;
  resolve(approved: boolean): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface DebugMcpApprovalService {
  request(details: Record<string, unknown>): Promise<boolean>;
  dispose(): void;
}

/**
 * Routes external MCP mutations through the renderer so the workbench can use
 * the same accessible, full-screen approval surface on every platform.
 */
export function registerDebugMcpApprovalService(
  ctx: ServiceContext,
  notify: (request: DebugMcpApprovalRequest) => void = () => undefined,
): DebugMcpApprovalService {
  const pending = new Map<string, PendingApproval>();

  const finish = (requestId: string, approved: boolean): void => {
    const approval = pending.get(requestId);
    if (!approval) throw new Error("The debug MCP approval is no longer pending");
    pending.delete(requestId);
    clearTimeout(approval.timeout);
    approval.resolve(approved);
  };

  ctx.ipcMain.handle(CH.debugMcpPendingApprovals, () =>
    [...pending.values()].map(({ request }) => request),
  );
  ctx.ipcMain.handle(
    CH.debugMcpRespondApproval,
    (_event, response: DebugMcpApprovalResponse) => {
      finish(response.requestId, response.approved);
    },
  );

  return {
    request(details) {
      const window = ctx.getWindow();
      if (!window || window.isDestroyed() || pending.size >= MAX_PENDING_APPROVALS) {
        return Promise.resolve(false);
      }
      const request: DebugMcpApprovalRequest = {
        requestId: randomUUID(),
        requestedAt: Date.now(),
        details,
      };
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          if (pending.delete(request.requestId)) resolve(false);
        }, APPROVAL_TIMEOUT_MS);
        pending.set(request.requestId, { request, resolve, timeout });
        ctx.send(CH.debugMcpApprovalRequest, request);
        notify(request);
      });
    },
    dispose() {
      for (const approval of pending.values()) {
        clearTimeout(approval.timeout);
        approval.resolve(false);
      }
      pending.clear();
      ctx.ipcMain.removeHandler(CH.debugMcpPendingApprovals);
      ctx.ipcMain.removeHandler(CH.debugMcpRespondApproval);
    },
  };
}
