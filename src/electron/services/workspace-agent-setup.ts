import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  WorkspaceAgentSetupRequest,
  WorkspaceAgentSetupResult,
  WorkspaceAgentSetupStatus,
} from "../../shared/types";

const SERVER_NAME = "logos-debug";
export const SKILL_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/compatibility.md",
  "scripts/validate-launch-json.mjs",
] as const;
export const MCP_FILES = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".codex/config.toml",
] as const;
const [MCP_JSON_FILE, CURSOR_MCP_FILE, VSCODE_MCP_FILE, CODEX_MCP_FILE] = MCP_FILES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(item => item.isFile()).catch(() => false);
}

async function jsonHasServer(file: string, key: "mcpServers" | "servers"): Promise<boolean> {
  try {
    const document: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isRecord(document) && isRecord(document[key]) &&
      Object.hasOwn(document[key], SERVER_NAME);
  } catch {
    return false;
  }
}

function codexTablePattern(): RegExp {
  return /^\s*\[mcp_servers\.(?:logos-debug|"logos-debug")\]\s*(?:#.*)?$/m;
}

async function codexHasServer(file: string): Promise<boolean> {
  return fs.readFile(file, "utf8").then(source => codexTablePattern().test(source)).catch(() => false);
}

function mcpServerConfig(root: string, serverPath: string): Record<string, unknown> {
  return {
    command: "node",
    args: [serverPath, "--workspace", root],
    cwd: root,
  };
}

async function mergeJsonServer(
  file: string,
  key: "mcpServers" | "servers",
  config: Record<string, unknown>,
  alternateKey?: "mcpServers" | "servers",
): Promise<boolean> {
  let document: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isRecord(parsed)) throw new Error(`${file} must contain a JSON object`);
    document = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Cannot update ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const existing = document[key];
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error(`Cannot update ${file}: '${key}' must be an object`);
  }
  const servers = isRecord(existing) ? existing : {};
  const alternate = alternateKey && isRecord(document[alternateKey])
    ? document[alternateKey]
    : undefined;
  if (
    Object.hasOwn(servers, SERVER_NAME) ||
    (alternate && Object.hasOwn(alternate, SERVER_NAME))
  ) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({ ...document, [key]: { ...servers, [SERVER_NAME]: config } }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function mergeCodexServer(file: string, root: string, serverPath: string): Promise<boolean> {
  const source = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (codexTablePattern().test(source)) return false;
  const separator = source.length === 0 || source.endsWith("\n\n")
    ? ""
    : source.endsWith("\n") ? "\n" : "\n\n";
  const block = [
    '[mcp_servers."logos-debug"]',
    'command = "node"',
    `args = [${tomlString(serverPath)}, "--workspace", ${tomlString(root)}]`,
    `cwd = ${tomlString(root)}`,
    'default_tools_approval_mode = "writes"',
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${source}${separator}${block}`, "utf8");
  return true;
}

export async function workspaceAgentSetupStatus(
  root: string,
): Promise<WorkspaceAgentSetupStatus> {
  const skillRoot = path.join(root, ".agents", "skills", "setup-launch-json");
  const [mcpJson, cursor, vscode, codex, skillFiles] = await Promise.all([
    Promise.all([
      jsonHasServer(path.join(root, MCP_JSON_FILE), "mcpServers"),
      jsonHasServer(path.join(root, MCP_JSON_FILE), "servers"),
    ]).then(values => values.some(Boolean)),
    jsonHasServer(path.join(root, CURSOR_MCP_FILE), "mcpServers"),
    jsonHasServer(path.join(root, VSCODE_MCP_FILE), "servers"),
    codexHasServer(path.join(root, CODEX_MCP_FILE)),
    Promise.all(SKILL_FILES.map(file => exists(path.join(skillRoot, file)))),
  ]);
  return {
    root,
    mcp: { mcpJson, cursor, vscode, codex },
    skill: skillFiles.every(Boolean),
  };
}

export async function setupWorkspaceAgents(
  request: WorkspaceAgentSetupRequest,
  options: { debugMcpServerPath: string; skillTemplateRoot: string },
): Promise<WorkspaceAgentSetupResult> {
  const changedFiles: string[] = [];
  const recordChange = (changed: boolean, relative: string) => {
    if (changed) changedFiles.push(relative);
  };
  if (request.installMcp) {
    const common = mcpServerConfig(request.root, options.debugMcpServerPath);
    recordChange(
      await mergeJsonServer(
        path.join(request.root, MCP_JSON_FILE),
        "mcpServers",
        common,
        "servers",
      ),
      MCP_JSON_FILE,
    );
    recordChange(
      await mergeJsonServer(
        path.join(request.root, CURSOR_MCP_FILE),
        "mcpServers",
        common,
      ),
      CURSOR_MCP_FILE,
    );
    recordChange(
      await mergeJsonServer(
        path.join(request.root, VSCODE_MCP_FILE),
        "servers",
        { type: "stdio", ...common },
      ),
      VSCODE_MCP_FILE,
    );
    recordChange(
      await mergeCodexServer(
        path.join(request.root, CODEX_MCP_FILE),
        request.root,
        options.debugMcpServerPath,
      ),
      CODEX_MCP_FILE,
    );
  }
  if (request.installSkill) {
    const targetRoot = path.join(request.root, ".agents", "skills", "setup-launch-json");
    for (const relative of SKILL_FILES) {
      const source = path.join(options.skillTemplateRoot, relative);
      const target = path.join(targetRoot, relative);
      if (await exists(target)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      changedFiles.push(path.join(".agents", "skills", "setup-launch-json", relative));
    }
  }
  return {
    ...(await workspaceAgentSetupStatus(request.root)),
    changedFiles,
  };
}
