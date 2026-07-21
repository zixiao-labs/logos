import type {
  AgentEffortLevel,
  AgentModelInfo,
  AgentPermissionMode,
} from "./types";

export const DEFAULT_LOGOS_MODEL = "gpt-5.6-sol";

const GPT_56_EFFORT_LEVELS: AgentEffortLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const GPT_54_EFFORT_LEVELS: AgentEffortLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];
const CODEX_SPARK_EFFORT_LEVELS: AgentEffortLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];

function gpt56Model(
  value: string,
  displayName: string,
  description: string,
): AgentModelInfo {
  return {
    value,
    displayName,
    description,
    supportsEffort: true,
    supportedEffortLevels: [...GPT_56_EFFORT_LEVELS],
  };
}

export const LOGOS_OPENAI_MODELS: readonly AgentModelInfo[] = [
  gpt56Model(
    "gpt-5.6",
    "GPT-5.6",
    "Sol alias for direct OpenAI API access",
  ),
  gpt56Model(
    "gpt-5.6-fast",
    "GPT-5.6 Fast",
    "Sol alias with priority processing",
  ),
  gpt56Model(
    "gpt-5.6-pro",
    "GPT-5.6 Pro",
    "Sol alias with Pro reasoning (API key only)",
  ),
  gpt56Model(
    "gpt-5.6-sol",
    "GPT-5.6 Sol",
    "Frontier model for complex coding and agentic work",
  ),
  gpt56Model(
    "gpt-5.6-sol-fast",
    "GPT-5.6 Sol Fast",
    "Sol with priority processing",
  ),
  gpt56Model(
    "gpt-5.6-sol-pro",
    "GPT-5.6 Sol Pro",
    "Sol with Pro reasoning (API key only)",
  ),
  gpt56Model(
    "gpt-5.6-terra",
    "GPT-5.6 Terra",
    "Balanced capability and cost",
  ),
  gpt56Model(
    "gpt-5.6-terra-fast",
    "GPT-5.6 Terra Fast",
    "Terra with priority processing",
  ),
  gpt56Model(
    "gpt-5.6-terra-pro",
    "GPT-5.6 Terra Pro",
    "Terra with Pro reasoning (API key only)",
  ),
  gpt56Model(
    "gpt-5.6-luna",
    "GPT-5.6 Luna",
    "Fast, cost-efficient model for high-volume work",
  ),
  gpt56Model(
    "gpt-5.6-luna-fast",
    "GPT-5.6 Luna Fast",
    "Luna with priority processing",
  ),
  gpt56Model(
    "gpt-5.6-luna-pro",
    "GPT-5.6 Luna Pro",
    "Luna with Pro reasoning (API key only)",
  ),
  {
    value: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Previous frontier model",
    supportsEffort: true,
    supportedEffortLevels: [...GPT_54_EFFORT_LEVELS],
  },
  {
    value: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Balanced coding model",
    supportsEffort: true,
    supportedEffortLevels: [...GPT_54_EFFORT_LEVELS],
  },
  {
    value: "gpt-5.4-mini",
    displayName: "GPT-5.4 mini",
    description: "Fast and efficient",
    supportsEffort: true,
    supportedEffortLevels: [...GPT_54_EFFORT_LEVELS],
  },
  {
    value: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    description: "Fast coding agent",
    supportsEffort: true,
    supportedEffortLevels: [...CODEX_SPARK_EFFORT_LEVELS],
  },
];

export type LogosOpenAIAuthType = "api-key" | "chatgpt";
export type LogosOpenAIMode = "fast" | "pro";

export interface LogosOpenAIModelTarget {
  apiModel: string;
  mode?: LogosOpenAIMode;
}

export function isGpt56Model(model: string): boolean {
  return /^gpt-5\.6(?:$|-)/.test(model);
}

export function resolveLogosOpenAIModel(
  model: string,
  authType: LogosOpenAIAuthType,
): LogosOpenAIModelTarget {
  const modeMatch = /^(gpt-5\.6(?:-(?:sol|terra|luna))?)-(fast|pro)$/.exec(
    model,
  );
  const apiModel = modeMatch?.[1] ?? model;
  const mode = modeMatch?.[2] as LogosOpenAIMode | undefined;

  if (authType === "chatgpt" && apiModel === "gpt-5.6") {
    throw new Error(
      "ChatGPT authentication requires gpt-5.6-sol, gpt-5.6-terra, or gpt-5.6-luna",
    );
  }
  if (authType === "chatgpt" && mode === "pro") {
    throw new Error("GPT-5.6 Pro mode requires an OpenAI API key");
  }
  return { apiModel, ...(mode ? { mode } : {}) };
}

export function logosOpenAIModels(
  authType?: LogosOpenAIAuthType,
): AgentModelInfo[] {
  return LOGOS_OPENAI_MODELS.filter(
    (model) =>
      authType !== "chatgpt" ||
      (!/^gpt-5\.6(?:-(?:fast|pro))?$/.test(model.value) &&
        !model.value.endsWith("-pro")),
  );
}

export interface LogosAgentToolInfo {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
  constraints: string;
}

export const LOGOS_AGENT_TOOLS: readonly LogosAgentToolInfo[] = [
  {
    name: "Read",
    title: "Read",
    description: "Read a UTF-8 text file with stable, numbered lines.",
    mutating: false,
    constraints: "Workspace only; maximum 1 MiB per file and 4,000 lines per call.",
  },
  {
    name: "Glob",
    title: "Glob",
    description: "List the immediate files and directories at a workspace path.",
    mutating: false,
    constraints: "Workspace only; returns at most 500 entries.",
  },
  {
    name: "Grep",
    title: "Grep",
    description: "Search workspace text files with a regular expression.",
    mutating: false,
    constraints: "Workspace only; supports a file glob and returns at most 100 matches.",
  },
  {
    name: "Write",
    title: "Write",
    description: "Create or completely replace a UTF-8 text file.",
    mutating: true,
    constraints: "Workspace only; approval may be required; maximum output size is 5 MiB.",
  },
  {
    name: "Bash",
    title: "Bash",
    description: "Run a shell command and capture its combined output.",
    mutating: true,
    constraints: "Workspace only; every command requires one-time approval; timeout is capped at 120 seconds; Windows requires an installed bash.exe.",
  },
  {
    name: "Skill",
    title: "Skill",
    description: "List or load project and user Agent Skills.",
    mutating: false,
    constraints: "Reads only files inside discovered skill directories; maximum 1 MiB per call.",
  },
  {
    name: "MCP",
    title: "MCP",
    description: "List and call tools from MCP servers configured in workspace .mcp.json.",
    mutating: true,
    constraints: "Servers start lazily; connections and calls require one-time approval.",
  },
  {
    name: "DAP_REPL",
    title: "DAP REPL",
    description: "Evaluate an expression in a running Debug Adapter Protocol session.",
    mutating: true,
    constraints: "Every expression requires one-time approval because evaluation may have side effects.",
  },
  {
    name: "Finish",
    title: "Finish",
    description: "Explicitly mark the current task complete after work and verification are done.",
    mutating: false,
    constraints: "Required to end the agent loop; do not call it while work remains.",
  },
] as const;

export function buildLogosAgentSystemPrompt(input: {
  workspace: string | readonly string[];
  mode: AgentPermissionMode;
}): string {
  const modeInstruction: Record<AgentPermissionMode, string> = {
    default:
      "Ask for client approval before Write. Bash, MCP execution, and DAP_REPL always require one-time approval. Read-only inspection does not require approval.",
    acceptEdits:
      "File edits are pre-approved, but Bash, MCP execution, and DAP_REPL still require one-time approval.",
    bypassPermissions:
      "The user explicitly enabled bypassPermissions. Write may run without approval, but Bash, MCP execution, and DAP_REPL still require one-time approval. All safety and workspace rules still apply.",
    plan:
      "Plan mode is read-only. Do not call Write, Bash, MCP, or DAP_REPL and do not claim that changes were applied.",
  };
  const toolContract = LOGOS_AGENT_TOOLS.map(
    (tool) =>
      `- ${tool.name}: ${tool.description} ${tool.constraints}`,
  ).join("\n");
  const workspaces: readonly string[] =
    typeof input.workspace === "string" ? [input.workspace] : input.workspace;
  const workspaceList = workspaces.map((root, index) => `${index + 1}. ${root}`).join("\n");

  return `# Identity
You are the built-in Logos coding agent running inside the Logos IDE. You are responsible for producing correct, minimal, verifiable changes in the active workspace.

# Workspace
The permitted workspace roots are:\n${workspaceList}
The first root is the default for relative paths. Use absolute paths to work in another root. Resolve every file and command working directory inside these roots. Never attempt to bypass path checks, follow a symbolic link outside the workspace, or access unrelated user data.

# Operating Mode
${modeInstruction[input.mode]}

# Workflow
1. Inspect relevant files before proposing or applying changes. Do not guess the repository structure.
2. For a multi-step task, state a short plan and immediately begin the first tool action in the same response. A plan alone is not progress.
3. Prefer the smallest correct change and preserve existing project conventions.
4. Read a file before replacing it. Do not erase content you have not inspected.
5. After edits, run the narrowest useful test, typecheck, or build command when available.
6. If a tool fails, use its actual error to adjust the approach. Never report an action as successful unless the tool result confirms it.
7. Continue the tool loop until all requested work and verification are complete. Then provide a concise summary and call Finish in that same response. Finish is the only way to end the loop.

# Tool Contract
${toolContract}

Call tools only with valid JSON matching their schemas. Write replaces the whole file, so preserve all intended existing content. Grep uses JavaScript regular-expression syntax. MCP servers are discovered from .mcp.json and must be listed before use. Skill with no name lists available skills; load a relevant skill before following it. DAP_REPL targets an existing debug session and can execute code in the debuggee.

# Communication
Be direct and factual. Distinguish observations, actions, and unverified assumptions. Ask one focused question only when a missing decision blocks safe progress.`;
}
