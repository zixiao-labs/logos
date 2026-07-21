const PRODUCTION_CONNECT_SOURCE = "'none'";

export function workbenchContentSecurityPolicy(devServerUrl?: string): string {
  let connectSource = PRODUCTION_CONNECT_SOURCE;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    connectSource = `'self' ${url.origin} ${websocketProtocol}//${url.host}`;
  }
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
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
