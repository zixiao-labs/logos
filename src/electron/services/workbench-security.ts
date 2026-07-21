import { createHash } from "node:crypto";

const PRODUCTION_CONNECT_SOURCE = "'none'";
const SCRIPT_HASH_SOURCE_PATTERN = /^'sha256-[A-Za-z0-9+/]{43}='$/;

export function inlineScriptCspSources(html: string): string[] {
  const sources = new Set<string>();
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const script = match[1];
    if (!script) continue;
    const digest = createHash("sha256").update(script).digest("base64");
    sources.add(`'sha256-${digest}'`);
  }
  return [...sources];
}

export function workbenchContentSecurityPolicy(
  devServerUrl?: string,
  inlineScriptSources: readonly string[] = [],
): string {
  let connectSource = PRODUCTION_CONNECT_SOURCE;
  let scriptSource = "'self'";
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    connectSource = `'self' ${url.origin} ${websocketProtocol}//${url.host}`;
    // Nasti injects the React Fast Refresh and Monaco bootstraps into the
    // development document. Production stays hash-only below.
    scriptSource = "'self' 'unsafe-inline'";
  } else if (inlineScriptSources.length > 0) {
    for (const source of inlineScriptSources) {
      if (!SCRIPT_HASH_SOURCE_PATTERN.test(source)) {
        throw new Error(`Invalid CSP script hash source: ${source}`);
      }
    }
    scriptSource = ["'self'", ...new Set(inlineScriptSources)].join(" ");
  }
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    `script-src ${scriptSource}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src ${connectSource}`,
  ].join("; ");
}

export function normalizeExternalUrl(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Invalid external URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid external URL.");
  }
  if (url.protocol === "https:") {
    if (url.username || url.password) {
      throw new Error("External URLs must not contain credentials.");
    }
    return url.toString();
  }
  if (url.protocol === "mailto:" && url.pathname) return url.toString();
  throw new Error(`Unsupported external URL protocol: ${url.protocol}`);
}
