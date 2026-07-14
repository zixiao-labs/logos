import type {
  DebugConfigurationFile,
  DebugLaunchConfiguration,
} from "../shared/dap";
import { basename } from "./language";

/** Remove JSONC comments without touching comment-like text inside strings. */
export function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        index++;
        blockComment = false;
      } else {
        result += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      result += "  ";
      index++;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      result += "  ";
      index++;
      blockComment = true;
    } else {
      result += char;
    }
  }
  return result;
}

function removeTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    result += char;
  }
  return result;
}

function isConfiguration(value: unknown): value is DebugLaunchConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const configuration = value as Partial<DebugLaunchConfiguration>;
  return (
    typeof configuration.name === "string" &&
    typeof configuration.type === "string" &&
    (configuration.request === "launch" || configuration.request === "attach")
  );
}

export function parseDebugConfigurationFile(source: string): DebugConfigurationFile {
  const parsed: unknown = JSON.parse(
    removeTrailingCommas(stripJsonComments(source)),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Debug configuration must be a JSON object");
  }
  const file = parsed as Partial<DebugConfigurationFile>;
  if (!Array.isArray(file.configurations)) {
    throw new Error("Debug configuration must contain a configurations array");
  }
  const invalid = file.configurations.findIndex(
    (configuration) => !isConfiguration(configuration),
  );
  if (invalid >= 0) {
    throw new Error(`Invalid debug configuration at index ${invalid}`);
  }
  return {
    version: typeof file.version === "string" ? file.version : "0.2.0",
    configurations: file.configurations as DebugLaunchConfiguration[],
  };
}

export interface DebugVariableContext {
  workspaceFolder: string;
  file?: string;
}

function substituteString(value: string, context: DebugVariableContext): string {
  const file = context.file ?? "";
  const workspaceFolder = context.workspaceFolder.replace(/[/\\]+$/, "");
  const fileIsInWorkspace =
    file === workspaceFolder ||
    file.startsWith(`${workspaceFolder}/`) ||
    file.startsWith(`${workspaceFolder}\\`);
  const relativeFile =
    file && fileIsInWorkspace
      ? file.slice(workspaceFolder.length).replace(/^[/\\]/, "")
      : file;
  const variables: Record<string, string> = {
    workspaceFolder: context.workspaceFolder,
    workspaceFolderBasename: basename(context.workspaceFolder),
    file,
    fileBasename: file ? basename(file) : "",
    fileDirname: file ? file.replace(/[/\\][^/\\]*$/, "") : "",
    relativeFile,
    pathSeparator: context.workspaceFolder.includes("\\") ? "\\" : "/",
  };
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) =>
    Object.hasOwn(variables, name)
      ? variables[name]
      : name.startsWith("workspaceFolder:") &&
          name.slice("workspaceFolder:".length) === basename(workspaceFolder)
        ? workspaceFolder
        : match,
  );
}

function substitute(value: unknown, context: DebugVariableContext): unknown {
  if (typeof value === "string") return substituteString(value, context);
  if (Array.isArray(value)) return value.map((item) => substitute(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, context)]),
    );
  }
  return value;
}

export function resolveDebugConfiguration(
  configuration: DebugLaunchConfiguration,
  context: DebugVariableContext,
): DebugLaunchConfiguration {
  return substitute(configuration, context) as DebugLaunchConfiguration;
}

export const DEFAULT_DEBUG_CONFIGURATION = `{
  // Logos uses the Debug Adapter Protocol. Node/Chrome/Electron resolve to the
  // packaged JavaScript adapter; other runtimes can provide an explicit adapter.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Node: Current File",
      "type": "node",
      "request": "launch",
      "program": "\${file}",
      "cwd": "\${workspaceFolder}",
      "console": "internalConsole"
    }
  ]
}
`;
