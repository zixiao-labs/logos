import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { safeStorage, shell } from "electron";
import type { AgentCredentialStatus } from "../../shared/types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_PORT = 1455;
const OAUTH_TIMEOUT_MS = 5 * 60_000;

interface OAuthCredential {
  type: "chatgpt";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

interface ApiKeyCredential {
  type: "api-key";
  apiKey: string;
}

type OpenAICredential = OAuthCredential | ApiKeyCredential;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export interface OpenAIRequestAuth {
  type: OpenAICredential["type"];
  url: string;
  headers: Record<string, string>;
}

interface JwtClaims {
  email?: string;
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function parseJwtClaims(token?: string): JwtClaims | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return undefined;
  }
}

function tokenIdentity(tokens: TokenResponse): { accountId?: string; email?: string } {
  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token);
  if (!claims) return {};
  const accountId =
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id;
  return { accountId, email: claims.email };
}

function callbackHtml(ok: boolean, message: string): string {
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html><meta charset="utf-8"><title>Logos</title><style>body{font:16px system-ui;background:#0d0f12;color:#e8ebf0;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;padding:32px;border:1px solid #30343b;border-radius:14px;background:#171a1f}h1{font-size:22px;color:${ok ? "#77d59b" : "#ff8585"}}</style><div class="card"><h1>${ok ? "Connected to ChatGPT" : "Login failed"}</h1><p>${escaped}</p><p>You can close this tab and return to Logos.</p></div>`;
}

function responsesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "") || "https://api.openai.com/v1";
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

async function exchangeTokens(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenAI token exchange failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<TokenResponse>;
}

export class OpenAIAuthStore {
  private readonly file: string;
  private loaded = false;
  private credential: OpenAICredential | null = null;
  private refreshPromise: Promise<OAuthCredential> | null = null;
  private loginPromise: Promise<AgentCredentialStatus> | null = null;
  private revision = 0;

  constructor(
    userDataDir: string,
    private readonly openExternal: (url: string) => Promise<unknown> = (url) =>
      shell.openExternal(url),
  ) {
    this.file = path.join(userDataDir, "credentials", "openai.enc");
  }

  async status(): Promise<AgentCredentialStatus> {
    const credential = await this.load();
    if (!credential) return { type: "none" };
    if (credential.type === "api-key") {
      return { type: "api-key", label: "OpenAI API key" };
    }
    return {
      type: "chatgpt",
      label: credential.email || "ChatGPT Plus/Pro",
      expiresAt: credential.expiresAt,
    };
  }

  async setApiKey(apiKey: string): Promise<AgentCredentialStatus> {
    const value = apiKey.trim();
    if (!value) throw new Error("OpenAI API key is required");
    this.revision += 1;
    await this.save({ type: "api-key", apiKey: value });
    return this.status();
  }

  async logout(): Promise<void> {
    this.revision += 1;
    this.credential = null;
    this.loaded = true;
    await fs.rm(this.file, { force: true });
  }

  async loginChatGPT(): Promise<AgentCredentialStatus> {
    if (!this.loginPromise) {
      const revision = ++this.revision;
      this.loginPromise = this.runBrowserLogin(revision).finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  async requestAuth(baseUrl: string): Promise<OpenAIRequestAuth> {
    let credential = await this.load();
    if (!credential) throw new Error("OpenAI authentication required");
    if (credential.type === "api-key") {
      return {
        type: "api-key",
        url: responsesUrl(baseUrl),
        headers: { Authorization: `Bearer ${credential.apiKey}` },
      };
    }
    if (credential.expiresAt <= Date.now() + 60_000) {
      credential = await this.refresh(credential);
    }
    return {
      type: "chatgpt",
      url: CODEX_RESPONSES_URL,
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        ...(credential.accountId
          ? { "ChatGPT-Account-Id": credential.accountId }
          : {}),
      },
    };
  }

  private async load(): Promise<OpenAICredential | null> {
    if (this.loaded) return this.credential;
    this.loaded = true;
    try {
      const encrypted = await fs.readFile(this.file);
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS secure storage is unavailable");
      }
      const raw = safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(raw) as OpenAICredential;
      if (parsed.type !== "api-key" && parsed.type !== "chatgpt") return null;
      this.credential = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.credential;
  }

  private async save(credential: OpenAICredential): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable; credentials were not saved");
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(credential));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, encrypted, { mode: 0o600 });
    await fs.rename(temp, this.file);
    this.credential = credential;
    this.loaded = true;
  }

  private async refresh(current: OAuthCredential): Promise<OAuthCredential> {
    if (!this.refreshPromise) {
      const revision = this.revision;
      this.refreshPromise = exchangeTokens(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: CLIENT_ID,
        }),
      )
        .then(async (tokens) => {
          if (revision !== this.revision || this.credential !== current) {
            throw new Error("OpenAI credentials changed while the token was refreshing");
          }
          const identity = tokenIdentity(tokens);
          const refreshed: OAuthCredential = {
            type: "chatgpt",
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? current.refreshToken,
            expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            accountId: identity.accountId ?? current.accountId,
            email: identity.email ?? current.email,
          };
          await this.save(refreshed);
          return refreshed;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }

  private async runBrowserLogin(revision: number): Promise<AgentCredentialStatus> {
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(32));
    const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`;
    const authorize = new URL(`${ISSUER}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      // This public Codex OAuth client currently expects OpenCode-compatible metadata.
      originator: "opencode",
    }).toString();

    let server: Server | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const tokens = await new Promise<TokenResponse>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: TokenResponse) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value!);
        };
        server = createServer(async (request, response) => {
          const url = new URL(request.url ?? "/", redirectUri);
          if (url.pathname !== "/auth/callback") {
            response.writeHead(404).end("Not found");
            return;
          }
          const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
          const code = url.searchParams.get("code");
          if (oauthError || !code || url.searchParams.get("state") !== state) {
            const error = new Error(oauthError || (!code ? "Missing authorization code" : "Invalid OAuth state"));
            response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            response.end(callbackHtml(false, error.message));
            finish(error);
            return;
          }
          try {
            const result = await exchangeTokens(
              new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: CLIENT_ID,
                code_verifier: verifier,
              }),
            );
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(callbackHtml(true, "Authorization completed successfully."));
            finish(undefined, result);
          } catch (error) {
            const value = error instanceof Error ? error : new Error(String(error));
            response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            response.end(callbackHtml(false, value.message));
            finish(value);
          }
        });
        server.once("error", (error) => finish(error));
        server.listen(OAUTH_PORT, "localhost", () => {
          void this.openExternal(authorize.toString()).catch((error) =>
            finish(error instanceof Error ? error : new Error(String(error))),
          );
        });
        timer = setTimeout(
          () => finish(new Error("ChatGPT login timed out")),
          OAUTH_TIMEOUT_MS,
        );
      });
      const identity = tokenIdentity(tokens);
      if (!tokens.refresh_token) throw new Error("OpenAI did not return a refresh token");
      if (revision !== this.revision) {
        throw new Error("ChatGPT login was superseded by another credential change");
      }
      await this.save({
        type: "chatgpt",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        ...identity,
      });
      return this.status();
    } finally {
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => {
        if (!server?.listening) resolve();
        else server.close(() => resolve());
      });
    }
  }
}
