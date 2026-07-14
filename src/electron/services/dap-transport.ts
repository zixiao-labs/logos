import type { Readable, Writable } from "node:stream";
import type {
  DapArguments,
  DapEvent,
  DapMessage,
  DapRequest,
  DapResponse,
} from "../../shared/dap";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

function isDapMessage(value: unknown): value is DapMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<DapMessage>;
  return (
    typeof message.seq === "number" &&
    (message.type === "request" ||
      message.type === "response" ||
      message.type === "event")
  );
}

/** Incremental DAP Content-Length parser; accepts arbitrary stream chunking. */
export class DapMessageParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private contentLength: number | null = null;

  push(chunk: Buffer | string): DapMessage[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const messages: DapMessage[] = [];

    while (true) {
      if (this.contentLength == null) {
        const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
        if (headerEnd < 0) break;
        const header = this.buffer.toString("ascii", 0, headerEnd);
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        const lengthHeader = header
          .split(/\r\n/)
          .map((line) => line.split(/:\s*/, 2))
          .find(([name]) => name.toLowerCase() === "content-length");
        const length = Number(lengthHeader?.[1]);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new Error("Malformed DAP Content-Length header");
        }
        if (length > MAX_MESSAGE_BYTES) {
          throw new Error(`DAP message exceeds ${MAX_MESSAGE_BYTES} bytes`);
        }
        this.contentLength = length;
      }

      if (this.buffer.length < this.contentLength) break;
      const json = this.buffer.toString("utf8", 0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = null;
      const parsed: unknown = JSON.parse(json);
      if (!isDapMessage(parsed)) throw new Error("Invalid DAP protocol message");
      messages.push(parsed);
    }

    return messages;
  }
}

export function encodeDapMessage(message: DapMessage): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

type PendingRequest = {
  command: string;
  resolve: (response: DapResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Bidirectional DAP peer over a pair of Node streams. */
export class DapConnection {
  private sequence = 1;
  private readonly parser = new DapMessageParser();
  private readonly pending = new Map<number, PendingRequest>();
  private eventListener: (event: DapEvent) => void = () => undefined;
  private requestListener: (request: DapRequest) => void = () => undefined;
  private errorListener: (error: Error) => void = () => undefined;
  private disposed = false;

  private readonly onData = (data: Buffer | string) => {
    try {
      for (const message of this.parser.push(data)) this.accept(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly onStreamError = (error: Error) => this.fail(error);
  private readonly onStreamClose = () =>
    this.fail(new Error("Debug adapter connection closed"));

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
  ) {
    readable.on("data", this.onData);
    readable.on("error", this.onStreamError);
    readable.on("close", this.onStreamClose);
    writable.on("error", this.onStreamError);
  }

  onEvent(listener: (event: DapEvent) => void): void {
    this.eventListener = listener;
  }

  onRequest(listener: (request: DapRequest) => void): void {
    this.requestListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  sendRequest<T = unknown>(
    command: string,
    args?: DapArguments,
    timeoutMs = 30_000,
  ): Promise<DapResponse<T>> {
    if (this.disposed) return Promise.reject(new Error("DAP connection is closed"));
    const request: DapRequest = {
      seq: this.sequence++,
      type: "request",
      command,
      ...(args && Object.keys(args).length ? { arguments: args } : {}),
    };
    return new Promise<DapResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.seq);
        reject(new Error(`Debug adapter request '${command}' timed out`));
      }, timeoutMs);
      this.pending.set(request.seq, {
        command,
        resolve: (response) => resolve(response as DapResponse<T>),
        reject,
        timer,
      });
      this.write(request);
    });
  }

  sendResponse(
    request: DapRequest,
    success: boolean,
    body?: unknown,
    message?: string,
  ): void {
    const response: DapResponse = {
      seq: this.sequence++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success,
      ...(body === undefined ? {} : { body }),
      ...(message ? { message } : {}),
    };
    this.write(response);
  }

  dispose(reason = "Debug adapter connection closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readable.off("data", this.onData);
    this.readable.off("error", this.onStreamError);
    this.readable.off("close", this.onStreamClose);
    this.writable.off("error", this.onStreamError);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private accept(message: DapMessage): void {
    switch (message.type) {
      case "event":
        this.eventListener(message);
        break;
      case "request":
        this.requestListener(message);
        break;
      case "response": {
        const pending = this.pending.get(message.request_seq);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.request_seq);
        if (!message.success) {
          pending.reject(
            new Error(
              message.message ||
                `Debug adapter request '${pending.command}' failed`,
            ),
          );
          return;
        }
        pending.resolve(message);
        break;
      }
    }
  }

  private write(message: DapMessage): void {
    try {
      this.writable.write(encodeDapMessage(message));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.errorListener(error);
    this.dispose(error.message);
  }
}
