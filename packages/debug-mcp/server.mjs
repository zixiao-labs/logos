#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspace = await fs.realpath(path.resolve(argument("--workspace") || process.cwd()));

function userKey() {
  const identity = String(process.getuid?.() ?? os.userInfo().username);
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

// Must match `debugMcpRegistryDirectory` in the Logos main process. MCP clients
// scrub `TMPDIR` out of the spawned environment but keep `HOME`/`USERPROFILE`,
// so a temp-based path would not resolve to the same directory Logos wrote to.
function registryDirectory() {
  return path.join(os.homedir(), ".logos", "debug-mcp", userKey());
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function registryRecords() {
  const directory = registryDirectory();
  const names = await fs.readdir(directory).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const metadata = await fs.stat(file);
      if (!metadata.isFile()) continue;
      if (process.platform !== "win32") {
        if ((metadata.mode & 0o077) !== 0) continue;
        if (process.getuid && metadata.uid !== process.getuid()) continue;
      }
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        record.protocolVersion !== PROTOCOL_VERSION ||
        !Number.isInteger(record.pid) ||
        !Number.isInteger(record.port) ||
        typeof record.token !== "string" ||
        !processIsAlive(record.pid)
      ) continue;
      records.push(record);
    } catch {
      // Ignore incomplete and stale discovery records.
    }
  }
  return records.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
}

function bridgeRequest(record, type, input) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: record.port });
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy(new Error("Logos debug bridge timed out"));
    });
    let buffer = "";
    let settled = false;
    let requestSent = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!error) {
        resolve(value);
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      // Once the request reaches the socket we can no longer tell whether Logos
      // ran it, which decides if resending is safe.
      failure.requestSent = requestSent;
      reject(failure);
    };
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          type,
          token: record.token,
          workspace,
          ...(input ? { input } : {}),
        })}\n`,
        () => {
          requestSent = true;
        },
      );
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Logos debug bridge response exceeds 16 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) {
          const error = new Error(response.error?.message || "Logos debug bridge rejected the request");
          error.code = response.error?.code;
          finish(error);
        } else {
          finish(null, response.result);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Logos debug bridge closed without a response")));
  });
}

let selectedRecord;

/** Populated by `register` so this never drifts from the published annotations. */
const readOnlyActions = new Set();

async function discoverBridge() {
  for (const record of await registryRecords()) {
    try {
      await bridgeRequest(record, "handshake");
      selectedRecord = record;
      return record;
    } catch {
      // Another Logos window may own a different workspace; keep looking.
    }
  }
  throw new Error(
    `No running Logos window has this workspace open: ${workspace}. Open it in Logos and try again.`,
  );
}

/**
 * Rediscovery must not turn one `debug_start`, `debug_stop` or `debug_evaluate`
 * into two. Resending is only safe when the action is read-only, when the bytes
 * never reached Logos, or when Logos answered with a code it only produces
 * before running anything.
 */
function mayResend(error, action) {
  if (readOnlyActions.has(action)) return true;
  if (!error?.requestSent) return true;
  return error?.code === "UNAUTHORIZED" || error?.code === "WORKSPACE_NOT_OPEN";
}

async function callDebug(input) {
  const record = selectedRecord || await discoverBridge();
  try {
    return await bridgeRequest(record, "execute", input);
  } catch (error) {
    if (error?.code === "DEBUG_ERROR") throw error;
    selectedRecord = undefined;
    if (!mayResend(error, input.action)) {
      throw new Error(
        `Logos did not confirm '${input.action}' and it may already have run: ${
          error?.message ?? String(error)
        }. Check debug_list_sessions before retrying.`,
      );
    }
    return bridgeRequest(await discoverBridge(), "execute", input);
  }
}

const server = new McpServer({ name: "logos-debug", version: "1.0.0" });
const sessionId = z.string().min(1).optional().describe("Debug session id; optional when exactly one session is active");
const threadId = z.number().int().optional();
const frameId = z.number().int().optional();
const breakpoint = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1).optional(),
  condition: z.string().optional(),
  hitCondition: z.string().optional(),
  logMessage: z.string().optional(),
});

function register(name, description, inputSchema, action, annotations = {}) {
  if (annotations.readOnlyHint) readOnlyActions.add(action);
  server.registerTool(
    name,
    { description, inputSchema, annotations },
    async input => {
      try {
        const result = await callDebug({ action, ...input });
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  );
}

register(
  "debug_list_configurations",
  "List launch.json configurations available in the open Logos workspace.",
  {},
  "list_configurations",
  { readOnlyHint: true, idempotentHint: true },
);
register(
  "debug_list_sessions",
  "List active Logos debug sessions and their capabilities/status.",
  {},
  "list_sessions",
  { readOnlyHint: true, idempotentHint: true },
);
register(
  "debug_start",
  "Start a named launch.json configuration in Logos.",
  {
    configuration: z.string().optional().describe("Optional only when launch.json has exactly one configuration"),
    active_file: z.string().optional(),
    source_path: z.string().optional(),
    breakpoints: z.array(breakpoint).optional(),
  },
  "start",
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
);
register("debug_stop", "Stop a Logos debug session.", {
  session_id: sessionId,
  terminate_debuggee: z.boolean().optional(),
}, "stop", { readOnlyHint: false, destructiveHint: true, idempotentHint: true });
register("debug_restart", "Restart a root Logos debug session with its current configuration.", {
  session_id: sessionId,
}, "restart", { readOnlyHint: false, destructiveHint: true, idempotentHint: false });
register("debug_continue", "Continue a paused debug thread.", {
  session_id: sessionId,
  thread_id: threadId,
}, "continue", { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
register("debug_pause", "Pause a running debug thread.", {
  session_id: sessionId,
  thread_id: threadId,
}, "pause", { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
for (const [name, action, description] of [
  ["debug_step_over", "step_over", "Step over the current source line."],
  ["debug_step_in", "step_in", "Step into the current call."],
  ["debug_step_out", "step_out", "Step out of the current frame."],
]) {
  register(name, description, { session_id: sessionId, thread_id: threadId }, action, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  });
}
register("debug_set_breakpoints", "Replace the breakpoints for one absolute workspace source path.", {
  session_id: sessionId,
  source_path: z.string().min(1),
  breakpoints: z.array(breakpoint),
}, "set_breakpoints", { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
register("debug_threads", "List threads in a debug session.", {
  session_id: sessionId,
}, "threads", { readOnlyHint: true, idempotentHint: true });
register("debug_stack_trace", "Read stack frames for a paused thread.", {
  session_id: sessionId,
  thread_id: threadId,
  start_frame: z.number().int().min(0).optional(),
  levels: z.number().int().min(1).optional(),
}, "stack_trace", { readOnlyHint: true, idempotentHint: true });
register("debug_scopes", "Read scopes for a stack frame.", {
  session_id: sessionId,
  frame_id: z.number().int(),
}, "scopes", { readOnlyHint: true, idempotentHint: true });
register("debug_variables", "Read variables from a DAP variablesReference, with optional paging.", {
  session_id: sessionId,
  variables_reference: z.number().int().min(1),
  start: z.number().int().min(0).optional(),
  count: z.number().int().min(1).optional(),
  filter: z.enum(["indexed", "named"]).optional(),
}, "variables", { readOnlyHint: true, idempotentHint: true });
register("debug_evaluate", "Evaluate an expression in the debuggee. The expression may have side effects.", {
  session_id: sessionId,
  expression: z.string().min(1),
  frame_id: frameId,
  context: z.enum(["watch", "repl", "hover", "clipboard", "variables"]).optional(),
}, "evaluate", { readOnlyHint: false, destructiveHint: true, idempotentHint: false });
register("debug_source", "Read source content exposed by the debug adapter.", {
  session_id: sessionId,
  source_reference: z.number().int().min(0),
  source_path: z.string().optional(),
}, "source", { readOnlyHint: true, idempotentHint: true });
register("debug_request", "Send an advanced raw DAP request to an active session.", {
  session_id: sessionId,
  command: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
}, "request", { readOnlyHint: false, destructiveHint: true, idempotentHint: false });

const transport = new StdioServerTransport();
await server.connect(transport);
