import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DebugControlInput } from "../../shared/debug-control";
import {
  isDebugControlAction,
  isDebugControlMutation,
} from "../../shared/debug-control";
import type { ServiceContext } from "./context";
import {
  applyDebugControlMutationApproval,
  executeDebugControl,
  prepareDebugControlMutationApproval,
} from "./debug-control";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;

interface BridgeRequest {
  type?: "handshake" | "execute";
  token?: string;
  workspace?: string;
  input?: DebugControlInput;
}

export type DebugMcpMutationApproval = (
  details: Record<string, unknown>,
) => Promise<boolean>;

function userKey(): string {
  const identity = String(process.getuid?.() ?? os.userInfo().username);
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** Shared with the stdio proxy; the directory is private to the OS user. */
export function debugMcpRegistryDirectory(): string {
  return path.join(os.tmpdir(), "logos-debug-mcp", userKey());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  if ((await readdir(directory).catch(() => [])).length === 0) {
    await rm(directory, { force: true, recursive: false }).catch(() => undefined);
  }
}

/**
 * Publish the in-process debugger over an authenticated loopback JSON bridge.
 * A standards-compliant stdio MCP proxy discovers this endpoint and never gets
 * direct access to Electron IPC or renderer privileges.
 */
export async function registerDebugMcpBridge(
  ctx: ServiceContext,
  approveMutation: DebugMcpMutationApproval = async () => false,
): Promise<() => Promise<void>> {
  if (!ctx.debug) throw new Error("Register the debug service before the MCP bridge");
  const controller = ctx.debug;
  const token = randomBytes(32).toString("hex");
  const registryDirectory = debugMcpRegistryDirectory();
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(registryDirectory, 0o700);

  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    let handled = false;

    const respond = (value: unknown) => {
      if (handled) return;
      handled = true;
      let payload = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
        payload = `${JSON.stringify({
          ok: false,
          error: { code: "RESPONSE_TOO_LARGE", message: "Debug response exceeds 16 MiB" },
        })}\n`;
      }
      socket.end(payload);
    };

    socket.on("data", chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        respond({
          ok: false,
          error: { code: "REQUEST_TOO_LARGE", message: "Debug request exceeds 1 MiB" },
        });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const source = buffer.slice(0, newline);
      void (async () => {
        let request: BridgeRequest;
        try {
          request = JSON.parse(source) as BridgeRequest;
        } catch {
          respond({ ok: false, error: { code: "INVALID_JSON", message: "Invalid JSON request" } });
          return;
        }
        if (request.token !== token) {
          respond({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid bridge token" } });
          return;
        }
        try {
          const workspace = await realpath(String(request.workspace ?? ""));
          await ctx.workspaceAccess?.assertWorkspaceRoot(workspace);
          if (request.type === "handshake") {
            respond({
              ok: true,
              result: { protocolVersion: PROTOCOL_VERSION, pid: process.pid, workspace },
            });
            return;
          }
          if (
            request.type !== "execute" ||
            !request.input ||
            !isDebugControlAction(request.input.action)
          ) {
            throw new Error("Invalid debug control request");
          }
          let input: DebugControlInput = {
            ...request.input,
            // Bind every operation to the canonical workspace authenticated above.
            // A client must not be able to redirect a valid bridge token to another root.
            workspace,
          };
          if (isDebugControlMutation(input.action)) {
            const approval = await prepareDebugControlMutationApproval(
              controller,
              workspace,
              input,
            );
            const allowed = await approveMutation({
              ...input,
              ...(approval.session ? { session: approval.session } : {}),
              ...(approval.configurationDetails
                ? {
                    configurationPath: approval.configurationPath,
                    configurationDetails: approval.configurationDetails,
                  }
                : {}),
            });
            if (!allowed) throw new Error("The debug action was not approved");
            input = applyDebugControlMutationApproval(controller, input, approval);
          }
          respond({
            ok: true,
            result: await executeDebugControl(controller, workspace, input),
          });
        } catch (error) {
          respond({
            ok: false,
            error: {
              code: /workspace/i.test(errorMessage(error)) ? "WORKSPACE_NOT_OPEN" : "DEBUG_ERROR",
              message: errorMessage(error),
            },
          });
        }
      })();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine the debug MCP bridge port");
  }

  const recordPath = path.join(registryDirectory, `${process.pid}.json`);
  await writePrivateJson(recordPath, {
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    port: address.port,
    token,
    startedAt: new Date().toISOString(),
  });

  return async () => {
    await rm(recordPath, { force: true }).catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeEmptyDirectory(registryDirectory);
  };
}

/** Test helper that validates a private registry record without exposing its token. */
export async function inspectDebugMcpRecord(file: string): Promise<{
  private: boolean;
  protocolVersion?: number;
  pid?: number;
  port?: number;
}> {
  const [metadata, source] = await Promise.all([stat(file), readFile(file, "utf8")]);
  const value = JSON.parse(source) as Record<string, unknown>;
  return {
    private: process.platform === "win32" || (metadata.mode & 0o077) === 0,
    protocolVersion: typeof value.protocolVersion === "number" ? value.protocolVersion : undefined,
    pid: typeof value.pid === "number" ? value.pid : undefined,
    port: typeof value.port === "number" ? value.port : undefined,
  };
}
