import type { Settings } from "../shared/types";

export interface LspRegistration {
  id: string;
  method: string;
  registerOptions?: Record<string, unknown>;
}

export interface LspConfigurationItem {
  scopeUri?: string;
  section?: string;
}

function setNested(target: Record<string, unknown>, path: string[], value: unknown) {
  let current = target;
  for (const part of path.slice(0, -1)) {
    const child = current[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function configurationSection(
  settings: Settings,
  section: string | undefined,
): unknown {
  const isSecret = (key: string) =>
    key === "agent.apiKey" || key === "agent.authToken";
  if (section && !isSecret(section) && settings[section] !== undefined) {
    return settings[section];
  }

  const result: Record<string, unknown> = {};
  const prefix = section ? `${section}.` : "";
  let found = false;
  for (const [key, value] of Object.entries(settings)) {
    if (isSecret(key)) continue;
    if (!key.startsWith(prefix)) continue;
    const relative = key.slice(prefix.length);
    if (!relative) continue;
    setNested(result, relative.split("."), value);
    found = true;
  }
  return found ? result : null;
}

export function resolveLspConfiguration(
  settings: Settings,
  items: LspConfigurationItem[],
): unknown[] {
  return items.map((item) => configurationSection(settings, item.section));
}

function globToRegExp(glob: string, ignoreCase = false): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i++;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end !== -1) {
        const alternatives = glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"));
        source += `(?:${alternatives.join("|")})`;
        i = end;
      } else {
        source += "\\{";
      }
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end !== -1) {
        const content = glob.slice(i + 1, end);
        source += `[${content.startsWith("!") ? `^${content.slice(1)}` : content}]`;
        i = end;
      } else {
        source += "\\[";
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

function expandBraces(glob: string): string[] {
  const start = glob.indexOf("{");
  if (start === -1) return [glob];
  const end = glob.indexOf("}", start + 1);
  if (end === -1) return [glob];
  const alternatives = glob.slice(start + 1, end).split(",");
  return alternatives.flatMap((alternative) =>
    expandBraces(`${glob.slice(0, start)}${alternative}${glob.slice(end + 1)}`),
  );
}

export function matchesLspGlob(
  glob: string,
  value: string,
  ignoreCase = false,
): boolean {
  try {
    const normalized = value.replaceAll("\\", "/");
    return expandBraces(glob).some((pattern) =>
      globToRegExp(pattern, ignoreCase).test(normalized),
    );
  } catch {
    return false;
  }
}

export function matchesLspDocumentSelector(
  registerOptions: Record<string, unknown> | undefined,
  language: string,
  uri: { scheme: string; path: string },
): boolean {
  const selector = registerOptions?.documentSelector;
  if (selector == null) return true;
  if (!Array.isArray(selector)) return false;
  return selector.some((entry) => {
    if (typeof entry === "string") return entry === language;
    if (!entry || typeof entry !== "object") return false;
    const filter = entry as {
      language?: string;
      scheme?: string;
      pattern?: string | { pattern?: string };
    };
    if (filter.language && filter.language !== language) return false;
    if (filter.scheme && filter.scheme !== uri.scheme) return false;
    const pattern =
      typeof filter.pattern === "string" ? filter.pattern : filter.pattern?.pattern;
    if (!pattern) return true;
    return matchesLspGlob(pattern, uri.path);
  });
}
