import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MCP_TIMEOUT_MS = 60_000;

interface StdioMcpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  disabled?: boolean;
}

interface HttpMcpServerConfig {
  type?: "http" | "streamable-http";
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

interface McpConnection {
  fingerprint: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

export interface McpRunResult {
  output: string;
  isError?: boolean;
}

export interface McpPermissionDetails {
  details: Record<string, unknown>;
  fingerprint?: string;
}

export interface McpToolInput extends Record<string, unknown> {
  action?: "list_servers" | "list_tools" | "call_tool";
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseServer(value: unknown): McpServerConfig | null {
  if (!isRecord(value) || value.disabled === true) return null;
  if (typeof value.command === "string" && value.command.trim()) {
    return {
      command: value.command,
      ...(Array.isArray(value.args)
        ? { args: value.args.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(stringRecord(value.env) ? { env: stringRecord(value.env) } : {}),
    };
  }
  if (typeof value.url === "string" && value.url.trim()) {
    return {
      type:
        value.type === "streamable-http" ? "streamable-http" : "http",
      url: value.url,
      ...(stringRecord(value.headers) ? { headers: stringRecord(value.headers) } : {}),
    };
  }
  return null;
}

function formatToolResult(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  if (Array.isArray(value.content)) {
    const content = value.content
      .map((item) => {
        if (!isRecord(item)) return JSON.stringify(item);
        if (item.type === "text" && typeof item.text === "string") return item.text;
        if (item.type === "resource" && isRecord(item.resource)) {
          return typeof item.resource.text === "string"
            ? item.resource.text
            : JSON.stringify(item.resource, null, 2);
        }
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
    if (content) return content;
  }
  return JSON.stringify(value, null, 2);
}

/** Workspace-scoped MCP host. Config is read without launching any server. */
export class WorkspaceMcpClient {
  private readonly connections = new Map<string, McpConnection>();

  constructor(private readonly workspaceRoot: string) {}

  async run(
    input: McpToolInput,
    signal?: AbortSignal,
    approvedFingerprint?: string,
  ): Promise<McpRunResult> {
    const action = input.action ?? "list_servers";
    const servers = await this.loadServers();
    if (action === "list_servers") {
      const entries = Object.entries(servers);
      return {
        output: entries.length
          ? entries
              .map(([name, config]) => `${name}\t${"command" in config ? "stdio" : "http"}`)
              .join("\n")
          : "No MCP servers are configured in .mcp.json",
      };
    }

    const serverName = String(input.server ?? "").trim();
    if (!serverName) throw new Error("MCP server is required");
    const config = servers[serverName];
    if (!config) throw new Error(`MCP server '${serverName}' is not configured`);
    if (approvedFingerprint !== JSON.stringify(config)) {
      throw new Error(
        approvedFingerprint
          ? `MCP server '${serverName}' changed after approval; review and approve it again`
          : `MCP server '${serverName}' was not approved`,
      );
    }
    const client = await this.connect(serverName, config, signal);

    if (action === "list_tools") {
      const result = await client.listTools(undefined, {
        signal,
        timeout: MCP_TIMEOUT_MS,
      });
      return {
        output: JSON.stringify(
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })),
          null,
          2,
        ),
      };
    }
    if (action !== "call_tool") throw new Error(`Unknown MCP action: ${action}`);

    const tool = String(input.tool ?? "").trim();
    if (!tool) throw new Error("MCP tool is required");
    const result = await client.callTool(
      {
        name: tool,
        arguments: isRecord(input.arguments) ? input.arguments : {},
      },
      undefined,
      { signal, timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
    );
    const output = formatToolResult(result);
    const isError = isRecord(result) && result.isError === true;
    return {
      output: isError ? `MCP tool error: ${output}` : output,
      ...(isError ? { isError: true } : {}),
    };
  }

  async permissionDetails(input: McpToolInput): Promise<McpPermissionDetails> {
    const server = String(input.server ?? "").trim();
    const config = server ? (await this.loadServers())[server] : undefined;
    return {
      details: {
        action: input.action ?? "list_servers",
        ...(server ? { server } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.arguments ? { arguments: input.arguments } : {}),
        ...(config
          ? {
              transport:
                "command" in config
                  ? {
                      command: config.command,
                      args: config.args,
                      cwd: config.cwd,
                      envNames: Object.keys(config.env ?? {}),
                    }
                  : {
                      type: config.type,
                      url: config.url,
                      headerNames: Object.keys(config.headers ?? {}),
                    },
            }
          : {}),
      },
      ...(config ? { fingerprint: JSON.stringify(config) } : {}),
    };
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      connections.map((connection) => this.closeConnection(connection)),
    );
  }

  private async closeConnection({ client, transport }: McpConnection): Promise<void> {
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      await transport.terminateSession().catch(() => undefined);
    }
    await client.close().catch(() => undefined);
  }

  private async loadServers(): Promise<Record<string, McpServerConfig>> {
    const file = path.join(this.workspaceRoot, ".mcp.json");
    let raw: string;
    try {
      const real = await fs.realpath(file);
      const relative = path.relative(this.workspaceRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(".mcp.json resolves outside the workspace");
      }
      const stat = await fs.stat(real);
      if (stat.size > MAX_CONFIG_BYTES) throw new Error(".mcp.json exceeds 1 MiB");
      raw = await fs.readFile(real, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const document = JSON.parse(raw) as unknown;
    if (!isRecord(document)) throw new Error(".mcp.json must contain an object");
    // Accept both common project formats. When both are present, the
    // mcpServers entry wins for a duplicate name without hiding VS Code-only
    // servers from Logos.
    const source = {
      ...(isRecord(document.servers) ? document.servers : {}),
      ...(isRecord(document.mcpServers) ? document.mcpServers : {}),
    };
    return Object.fromEntries(
      Object.entries(source).flatMap(([name, value]) => {
        const config = parseServer(value);
        return config ? [[name, config]] : [];
      }),
    );
  }

  private async connect(
    name: string,
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<Client> {
    const fingerprint = JSON.stringify(config);
    const existing = this.connections.get(name);
    if (existing?.fingerprint === fingerprint) return existing.client;
    if (existing) {
      this.connections.delete(name);
      await this.closeConnection(existing);
    }

    const client = new Client({ name: "logos", version: "1.4.0" });
    const transport =
      "command" in config
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: await this.workspaceDirectory(config.cwd),
            env: {
              ...getDefaultEnvironment(),
              ...config.env,
            },
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(this.httpUrl(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          });
    client.onclose = () => {
      if (this.connections.get(name)?.client === client) this.connections.delete(name);
    };
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.connections.set(name, { fingerprint, client, transport });
    return client;
  }

  private async workspaceDirectory(input?: string): Promise<string> {
    const target = path.resolve(this.workspaceRoot, input || ".");
    const real = await fs.realpath(target);
    const relative = path.relative(this.workspaceRoot, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`MCP working directory is outside the workspace: ${input}`);
    }
    return real;
  }

  private httpUrl(input: string): URL {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported MCP URL protocol: ${url.protocol}`);
    }
    return url;
  }
}
