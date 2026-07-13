import { useEffect, useRef, useState } from "react";

interface MessageActionItem {
  title: string;
  [key: string]: unknown;
}

export interface LspMessageRequestDetail {
  type?: number;
  message: string;
  actions: MessageActionItem[];
  signal?: AbortSignal;
  resolve(value: MessageActionItem | null): void;
}

export function LspMessageDialog() {
  const queue = useRef<LspMessageRequestDetail[]>([]);
  const [request, setRequest] = useState<LspMessageRequestDetail | null>(null);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const next = (event as CustomEvent<LspMessageRequestDetail>).detail;
      setRequest((current) => {
        if (current) {
          queue.current.push(next);
          return current;
        }
        return next;
      });
    };
    window.addEventListener("logos:lsp-message-request", onRequest);
    return () => window.removeEventListener("logos:lsp-message-request", onRequest);
  }, []);

  useEffect(() => {
    if (!request?.signal) return;
    const onAbort = () => {
      request.resolve(null);
      setRequest(queue.current.shift() ?? null);
    };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    return () => request.signal?.removeEventListener("abort", onAbort);
  }, [request]);

  if (!request) return null;

  const finish = (value: MessageActionItem | null) => {
    request.resolve(value);
    setRequest(queue.current.shift() ?? null);
  };

  const heading =
    request.type === 1 ? "Language Server Error" :
      request.type === 2 ? "Language Server Warning" : "Language Server";

  return (
    <div className="overlay" onMouseDown={() => finish(null)}>
      <div className="lsp-message" onMouseDown={(event) => event.stopPropagation()}>
        <strong>{heading}</strong>
        <p>{request.message}</p>
        <div className="lsp-message-actions">
          {request.actions.map((action, index) => (
            <button
              className="btn"
              key={`${action.title}:${index}`}
              onClick={() => finish(action)}
            >
              {action.title}
            </button>
          ))}
          <button className="btn" onClick={() => finish(null)}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
