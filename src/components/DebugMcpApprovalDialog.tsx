import { useEffect, useMemo, useState } from "react";
import { AlertDialog, Button } from "@heroui/react";
import type { DebugMcpApprovalRequest } from "../shared/debug-control";
import { useT } from "../i18n";
import { notifyError, notifyInfo, notifySuccess } from "../lib/toast";

function actionLabel(request: DebugMcpApprovalRequest): string {
  const action = String(request.details.action ?? "debug");
  return action.replaceAll("_", " ");
}

export function DebugMcpApprovalDialog() {
  const t = useT();
  const [requests, setRequests] = useState<DebugMcpApprovalRequest[]>([]);
  const [responding, setResponding] = useState(false);
  const request = requests[0];
  const currentAction = request ? actionLabel(request) : "";
  const detail = useMemo(
    () => (request ? JSON.stringify(request.details, null, 2) : ""),
    [request],
  );

  useEffect(() => {
    let mounted = true;
    const enqueue = (incoming: DebugMcpApprovalRequest) => {
      if (!mounted) return;
      setRequests((current) =>
        current.some((item) => item.requestId === incoming.requestId)
          ? current
          : [...current, incoming],
      );
    };
    const off = window.logos.debug.onMcpApproval(enqueue);
    void window.logos.debug.pendingMcpApprovals().then((pending) => {
      for (const item of pending) enqueue(item);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const respond = async (approved: boolean) => {
    if (!request || responding) return;
    setResponding(true);
    try {
      await window.logos.debug.respondMcpApproval({
        requestId: request.requestId,
        approved,
      });
      setRequests((current) =>
        current.filter((item) => item.requestId !== request.requestId),
      );
      if (approved) {
        notifySuccess(t("debug.mcpApproved"), actionLabel(request));
      } else {
        notifyInfo(t("debug.mcpDenied"), actionLabel(request));
      }
    } catch (error) {
      setRequests((current) =>
        current.filter((item) => item.requestId !== request.requestId),
      );
      notifyError(
        t("debug.mcpApprovalExpired"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setResponding(false);
    }
  };

  return (
    <AlertDialog.Backdrop
      isDismissable={false}
      isKeyboardDismissDisabled
      isOpen={Boolean(request)}
    >
      <AlertDialog.Container placement="center" size="cover">
        <AlertDialog.Dialog className="flex h-[calc(100vh-2rem)] max-h-none flex-col sm:h-[calc(100vh-5rem)]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning" />
            <div className="min-w-0">
              <AlertDialog.Heading>{t("debug.mcpApprovalTitle")}</AlertDialog.Heading>
              <p className="mt-1 text-sm text-muted">
                {t("debug.mcpApprovalSubtitle")} · {currentAction}
              </p>
            </div>
          </AlertDialog.Header>
          <AlertDialog.Body className="min-h-0 flex-1 overflow-auto">
            <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
              <section className="rounded-2xl border border-divider bg-surface-secondary p-5">
                <h3 className="text-sm font-semibold">{t("debug.mcpApprovalReview")}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {t("debug.mcpApprovalBody")}
                </p>
                {requests.length > 1 && (
                  <p className="mt-4 text-xs text-warning">
                    {t("debug.mcpApprovalQueued").replace("{count}", String(requests.length - 1))}
                  </p>
                )}
              </section>
              <section className="min-w-0 rounded-2xl border border-divider bg-surface p-5">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                  {t("debug.mcpApprovalDetails")}
                </div>
                <pre className="max-h-[calc(100vh-15rem)] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-default p-4 text-xs leading-5 text-foreground">
                  {detail}
                </pre>
              </section>
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button
              isDisabled={responding}
              variant="tertiary"
              onPress={() => void respond(false)}
            >
              {t("debug.mcpDeny")}
            </Button>
            <Button
              isDisabled={responding}
              variant="primary"
              onPress={() => void respond(true)}
            >
              {t("debug.mcpAllowOnce")}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
