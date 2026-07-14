import { describe, expect, it } from "@lightning-js/lightning";
import { PassThrough } from "node:stream";
import type { DapMessage, DapRequest } from "../../shared/dap";
import {
  DapConnection,
  DapMessageParser,
  encodeDapMessage,
} from "./dap-transport";

describe("DAP transport", () => {
  it("parses fragmented UTF-8 messages and coalesced frames", () => {
    const first: DapMessage = {
      seq: 1,
      type: "event",
      event: "output",
      body: { output: "你好, debugger" },
    };
    const second: DapMessage = {
      seq: 2,
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint" },
    };
    const bytes = Buffer.concat([
      encodeDapMessage(first),
      encodeDapMessage(second),
    ]);
    const parser = new DapMessageParser();
    const messages = [
      ...parser.push(bytes.subarray(0, 7)),
      ...parser.push(bytes.subarray(7, 31)),
      ...parser.push(bytes.subarray(31)),
    ];
    expect(messages).toEqual([first, second]);
  });

  it("matches responses to requests and answers reverse requests", async () => {
    const fromAdapter = new PassThrough();
    const toAdapter = new PassThrough();
    const outgoing = new DapMessageParser();
    const seen: DapMessage[] = [];
    toAdapter.on("data", (data: Buffer) => seen.push(...outgoing.push(data)));
    const connection = new DapConnection(fromAdapter, toAdapter);
    connection.onRequest((request) => {
      connection.sendResponse(request, true, { processId: 42 });
    });

    const responsePromise = connection.sendRequest<{ threads: unknown[] }>(
      "threads",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = seen[0] as DapRequest;
    fromAdapter.write(
      encodeDapMessage({
        seq: 10,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: true,
        body: { threads: [] },
      }),
    );
    expect((await responsePromise).body).toEqual({ threads: [] });

    fromAdapter.write(
      encodeDapMessage({
        seq: 11,
        type: "request",
        command: "runInTerminal",
        arguments: { args: ["node", "app.js"] },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.at(-1)).toMatchObject({
      type: "response",
      request_seq: 11,
      success: true,
      body: { processId: 42 },
    });
    connection.dispose();
  });

  it("rejects malformed content lengths", () => {
    const parser = new DapMessageParser();
    expect(() => parser.push("Content-Length: nope\r\n\r\n{}"))
      .toThrow();
  });

  it("rejects oversized headers before buffering them indefinitely", () => {
    const parser = new DapMessageParser();
    expect(() => parser.push(`X-Debug: ${"x".repeat(8 * 1024)}`)).toThrow(
      /header exceeds/,
    );
  });

  it("accepts a maximum-size header split inside its separator", () => {
    const body = JSON.stringify({ seq: 1, type: "event", event: "ready" });
    const prefix = `Content-Length: ${Buffer.byteLength(body)}\r\nX-Fill: `;
    const header = `${prefix}${"x".repeat(8 * 1024 - prefix.length)}`;
    const parser = new DapMessageParser();

    expect(parser.push(`${header}\r`)).toEqual([]);
    expect(parser.push("\n\r")).toEqual([]);
    expect(parser.push(`\n${body}`)).toEqual([
      { seq: 1, type: "event", event: "ready" },
    ]);
  });

  it("rejects protocol messages with missing required fields", () => {
    const parser = new DapMessageParser();
    const body = JSON.stringify({ seq: 1, type: "response", success: true });
    expect(() =>
      parser.push(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`),
    ).toThrow("Invalid DAP protocol message");
  });

  it("rejects zero protocol sequence numbers", () => {
    const parser = new DapMessageParser();
    const body = JSON.stringify({ seq: 0, type: "event", event: "stopped" });
    expect(() =>
      parser.push(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`),
    ).toThrow("Invalid DAP protocol message");
  });

  it("uses structured DAP error details", async () => {
    const fromAdapter = new PassThrough();
    const toAdapter = new PassThrough();
    const outgoing = new DapMessageParser();
    const seen: DapMessage[] = [];
    toAdapter.on("data", (data: Buffer) => seen.push(...outgoing.push(data)));
    const connection = new DapConnection(fromAdapter, toAdapter);
    const result = connection.sendRequest("launch");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = seen[0] as DapRequest;

    fromAdapter.write(
      encodeDapMessage({
        seq: 2,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: false,
        message: "failed",
        body: {
          error: {
            format: "Cannot launch {program}",
            variables: { program: "app.js" },
          },
        },
      }),
    );

    await expect(result).rejects.toThrow("Cannot launch app.js");
    connection.dispose();
  });

  it("cancels pending requests and notifies capable adapters", async () => {
    const fromAdapter = new PassThrough();
    const toAdapter = new PassThrough();
    const outgoing = new DapMessageParser();
    const seen: DapMessage[] = [];
    toAdapter.on("data", (data: Buffer) => seen.push(...outgoing.push(data)));
    const connection = new DapConnection(fromAdapter, toAdapter);
    const result = connection.sendRequest("stackTrace", { threadId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    connection.cancelPendingRequests(["stackTrace"], true);

    await expect(result).rejects.toThrow("cancelled");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      type: "request",
      command: "cancel",
      arguments: { requestId: (seen[0] as DapRequest).seq },
    });
    connection.dispose();
  });
});
