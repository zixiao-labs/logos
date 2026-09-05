import { useEffect, useState } from "react";
import { Button, Card } from "@heroui/react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { DEFAULT_LOGOS_MODEL } from "../shared/logos-agent";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { ACP_SECRET_MASK, isSensitiveEnvName } from "../shared/acp-env";
import type { AcpAgentConfig, Settings } from "../shared/types";

const ACP_SECRET_CLEANUP_KEY = "logos.acpSecretCleanup.v1";
let acpSecretCleanupMutation: Promise<void> = Promise.resolve();

function readAcpSecretCleanupQueue(): Set<string> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(ACP_SECRET_CLEANUP_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (reference): reference is string => typeof reference === "string",
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeAcpSecretCleanupQueue(references: Set<string>): void {
  if (references.size) {
    localStorage.setItem(ACP_SECRET_CLEANUP_KEY, JSON.stringify([...references]));
  } else {
    localStorage.removeItem(ACP_SECRET_CLEANUP_KEY);
  }
}

function mutateAcpSecretCleanup<T>(operation: () => Promise<T>): Promise<T> {
  const result = acpSecretCleanupMutation.then(operation, operation);
  acpSecretCleanupMutation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function enqueueAcpSecretCleanup(references: Iterable<string>): void {
  const pending = readAcpSecretCleanupQueue();
  for (const reference of references) pending.add(reference);
  writeAcpSecretCleanupQueue(pending);
}

async function runAcpSecretCleanup(): Promise<void> {
  const state = useStore.getState();
  if (!state.ready) return;
  const liveReferences = new Set(
    state.settings["agent.acpServers"].flatMap((server) =>
      Object.values(server.secretEnv ?? {}),
    ),
  );
  const failed = new Set<string>();
  for (const reference of readAcpSecretCleanupQueue()) {
    if (liveReferences.has(reference)) continue;
    try {
      await window.logos.settings.deleteAcpSecret(reference);
    } catch {
      failed.add(reference);
    }
  }
  writeAcpSecretCleanupQueue(failed);
}

function retryAcpSecretCleanup(): Promise<void> {
  return mutateAcpSecretCleanup(runAcpSecretCleanup);
}

function acpEnvironmentDisplay(server: AcpAgentConfig): string {
  return JSON.stringify(
    {
      ...server.env,
      ...Object.fromEntries(
        Object.keys(server.secretEnv ?? {}).map((name) => [name, ACP_SECRET_MASK]),
      ),
    },
    null,
    2,
  );
}

interface AcpDraft {
  canonical: string;
  value: string;
}

function Switch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={`switch ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      <span className="knob" />
    </button>
  );
}

/** Masked text input with a reveal toggle, for credentials. */
function Secret({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input
        className="field"
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        className="btn ghost"
        style={{ width: "auto" }}
        onClick={() => setShow((s) => !s)}
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

interface RowProps {
  name: string;
  settingKey: string;
  children: React.ReactNode;
}
function Row({ name, settingKey, children }: RowProps) {
  return (
    <div className="setting-row">
      <div className="meta">
        <div className="name">{name}</div>
        <div className="key">{settingKey}</div>
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function AcpServersEditor({
  servers,
  referencedIds,
  onChange,
}: {
  servers: AcpAgentConfig[];
  referencedIds: Set<string>;
  onChange: (servers: AcpAgentConfig[]) => Promise<void>;
}) {
  const settingsReady = useStore((state) => state.ready);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, AcpDraft>>(
    {},
  );
  const [environmentDrafts, setEnvironmentDrafts] = useState<
    Record<string, AcpDraft>
  >({});

  useEffect(() => {
    void retryAcpSecretCleanup().catch(() => undefined);
  }, [servers, settingsReady]);

  useEffect(() => {
    setArgumentDrafts((drafts) =>
      Object.fromEntries(
        servers.map((server) => {
          const canonical = JSON.stringify(server.args);
          const current = drafts[server.id];
          return [
            server.id,
            current?.canonical === canonical
              ? current
              : { canonical, value: canonical },
          ];
        }),
      ),
    );
    setEnvironmentDrafts((drafts) =>
      Object.fromEntries(
        servers.map((server) => {
          const canonical = JSON.stringify([server.env, server.secretEnv ?? {}]);
          const current = drafts[server.id];
          return [
            server.id,
            current?.canonical === canonical
              ? current
              : { canonical, value: acpEnvironmentDisplay(server) },
          ];
        }),
      ),
    );
  }, [servers]);

  const update = (id: string, patch: Partial<AcpAgentConfig>) => {
    return mutateAcpSecretCleanup(() =>
      onChange(
        useStore
          .getState()
          .settings["agent.acpServers"].map((server) =>
            server.id === id ? { ...server, ...patch } : server,
          ),
      ),
    );
  };

  async function updateEnvironment(
    serverId: string,
    value: string,
  ): Promise<Record<string, string>> {
    return mutateAcpSecretCleanup(async () => {
      const server = useStore
        .getState()
        .settings["agent.acpServers"].find((item) => item.id === serverId);
      if (!server) throw new Error("ACP server is unavailable");
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("ACP environment must be a JSON object");
      }
      const entries = Object.entries(parsed);
      for (const [name, rawValue] of entries) {
        if (typeof rawValue !== "string") {
          throw new Error(`ACP environment value must be a string: ${name}`);
        }
      }
      const env: Record<string, string> = {};
      const secretEnv: Record<string, string> = {};
      const createdReferences: string[] = [];
      try {
        for (const [name, rawValue] of entries as Array<[string, string]>) {
          const existingReference = server.secretEnv?.[name];
          if (!existingReference && !isSensitiveEnvName(name)) {
            env[name] = rawValue;
            continue;
          }
          if (rawValue === ACP_SECRET_MASK) {
            if (!existingReference) throw new Error(`Enter a value for ${name}`);
            secretEnv[name] = existingReference;
          } else {
            const reference = await window.logos.settings.setAcpSecret(
              server.id,
              name,
              rawValue,
            );
            secretEnv[name] = reference;
            createdReferences.push(reference);
            enqueueAcpSecretCleanup([reference]);
          }
        }
        enqueueAcpSecretCleanup(
          Object.entries(server.secretEnv ?? {}).flatMap(([name, reference]) =>
            secretEnv[name] === reference ? [] : [reference],
          ),
        );
        await onChange(
          useStore
            .getState()
            .settings["agent.acpServers"].map((item) =>
              item.id === server.id
                ? {
                    ...item,
                    env,
                    secretEnv: Object.keys(secretEnv).length
                      ? secretEnv
                      : undefined,
                  }
                : item,
            ),
        );
      } catch (error) {
        let queued = true;
        try {
          enqueueAcpSecretCleanup(createdReferences);
        } catch {
          queued = false;
        }
        if (!queued) {
          await Promise.allSettled(
            createdReferences.map((reference) =>
              window.logos.settings.deleteAcpSecret(reference),
            ),
          );
        }
        await runAcpSecretCleanup().catch(() => undefined);
        throw error;
      }
      await runAcpSecretCleanup().catch(() => undefined);
      return {
        ...env,
        ...Object.fromEntries(
          Object.keys(secretEnv).map((name) => [name, ACP_SECRET_MASK]),
        ),
      };
    });
  }

  async function removeServer(server: AcpAgentConfig): Promise<void> {
    if (referencedIds.has(server.id)) return;
    await mutateAcpSecretCleanup(async () => {
      const current = useStore.getState().settings["agent.acpServers"];
      const latest = current.find((item) => item.id === server.id) ?? server;
      enqueueAcpSecretCleanup(Object.values(latest.secretEnv ?? {}));
      try {
        await onChange(current.filter((item) => item.id !== server.id));
      } finally {
        await runAcpSecretCleanup().catch(() => undefined);
      }
    });
  }

  return (
    <div className="acp-server-list">
      {servers.map((server) => (
        <Card key={server.id} className="acp-server-card" variant="secondary">
          <Card.Header>
            <Card.Title>{server.name || server.id}</Card.Title>
            <Button
              isIconOnly
              aria-label="Remove ACP server"
              size="sm"
              variant="danger"
              isDisabled={
                referencedIds.has(server.id) || busyServerId === server.id
              }
              onPress={() => void removeServer(server)}
            >
              ×
            </Button>
          </Card.Header>
          <Card.Content className="acp-server-fields">
            <code>{server.id}</code>
            <input
              className="field"
              aria-label="Agent name"
              placeholder="Display name"
              disabled={busyServerId === server.id}
              value={server.name}
              onChange={(event) =>
                void update(server.id, { name: event.target.value })
              }
            />
            <input
              className="field"
              aria-label="Agent command"
              placeholder="opencode"
              disabled={busyServerId === server.id}
              value={server.command}
              onChange={(event) =>
                void update(server.id, { command: event.target.value })
              }
            />
            <input
              className="field"
              aria-label="Agent arguments"
              placeholder='["acp"]'
              disabled={busyServerId === server.id}
              value={
                argumentDrafts[server.id]?.value ?? JSON.stringify(server.args)
              }
              onChange={(event) =>
                setArgumentDrafts((drafts) => ({
                  ...drafts,
                  [server.id]: {
                    canonical: JSON.stringify(server.args),
                    value: event.target.value,
                  },
                }))
              }
              onBlur={(event) => {
                try {
                  const args = JSON.parse(event.currentTarget.value) as unknown;
                  if (
                    !Array.isArray(args) ||
                    args.some((arg) => typeof arg !== "string")
                  ) {
                    throw new Error("Agent arguments must be a JSON string array");
                  }
                  void update(server.id, { args }).catch(() => {
                    setArgumentDrafts((drafts) => ({
                      ...drafts,
                      [server.id]: {
                        canonical: JSON.stringify(server.args),
                        value: JSON.stringify(server.args),
                      },
                    }));
                  });
                } catch {
                  setArgumentDrafts((drafts) => ({
                    ...drafts,
                    [server.id]: {
                      canonical: JSON.stringify(server.args),
                      value: JSON.stringify(server.args),
                    },
                  }));
                }
              }}
            />
            <textarea
              className="field acp-env"
              aria-label="Agent environment"
              placeholder='{"OPENAI_API_KEY":"..."}'
              disabled={busyServerId === server.id}
              value={
                environmentDrafts[server.id]?.value ?? acpEnvironmentDisplay(server)
              }
              onChange={(event) =>
                setEnvironmentDrafts((drafts) => ({
                  ...drafts,
                  [server.id]: {
                    canonical: JSON.stringify([server.env, server.secretEnv ?? {}]),
                    value: event.target.value,
                  },
                }))
              }
              onBlur={(event) => {
                setBusyServerId(server.id);
                void updateEnvironment(server.id, event.currentTarget.value)
                  .then((displayEnv) => {
                    const value = JSON.stringify(displayEnv, null, 2);
                    const latest = useStore
                      .getState()
                      .settings["agent.acpServers"].find(
                        (item) => item.id === server.id,
                      );
                    setEnvironmentDrafts((drafts) => ({
                      ...drafts,
                      [server.id]: {
                        canonical: JSON.stringify([
                          latest?.env ?? server.env,
                          latest?.secretEnv ?? server.secretEnv ?? {},
                        ]),
                        value,
                      },
                    }));
                  })
                  .catch(() => {
                    const latest = useStore
                      .getState()
                      .settings["agent.acpServers"].find(
                        (item) => item.id === server.id,
                      );
                    if (latest) {
                      setEnvironmentDrafts((drafts) => ({
                        ...drafts,
                        [server.id]: {
                          canonical: JSON.stringify([
                            latest.env,
                            latest.secretEnv ?? {},
                          ]),
                          value: acpEnvironmentDisplay(latest),
                        },
                      }));
                    }
                  })
                  .finally(() => {
                    setBusyServerId((current) =>
                      current === server.id ? null : current,
                    );
                  });
              }}
            />
          </Card.Content>
        </Card>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onPress={() =>
          void mutateAcpSecretCleanup(() =>
            onChange([
              ...useStore.getState().settings["agent.acpServers"],
              {
                id: `acp-${crypto.randomUUID()}`,
                name: "ACP Agent",
                command: "",
                args: [],
                env: {},
              },
            ]),
          )
        }
      >
        Add ACP agent
      </Button>
    </div>
  );
}

export function SettingsView() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const setManySettings = useStore((s) => s.setManySettings);
  const resetSettings = useStore((s) => s.resetSettings);
  const registry = useStore((s) => s.agentRegistry);
  const agentSessions = useStore((s) => s.agentSessions);
  const credentialStatus = useStore((s) => s.agentCredentialStatus);
  const loginChatGPT = useStore((s) => s.loginChatGPT);
  const setOpenAIKey = useStore((s) => s.setOpenAIKey);
  const logoutOpenAI = useStore((s) => s.logoutOpenAI);
  const loadAgentRegistry = useStore((s) => s.loadAgentRegistry);
  const [mode, setMode] = useState<"gui" | "json">("gui");
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [openAIKey, setOpenAIKeyValue] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    window.logos.settings.getPath().then(setPath);
  }, []);
  useEffect(() => {
    if (mode === "json") setJson(JSON.stringify(settings, null, 2));
  }, [mode, settings]);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    void setSetting(key, value);
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(json) as Partial<Settings>;
      setJsonError(null);
      void setManySettings(parsed);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "Invalid JSON");
    }
  }

  async function runAuth(action: () => Promise<void>) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await action();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <div className="settings-view">
      <div className="settings-head">
        <h2 style={{ margin: 0 }}>{t("settings.title")}</h2>
        <div className="seg">
          <button
            className={mode === "gui" ? "active" : ""}
            onClick={() => setMode("gui")}
          >
            {t("settings.gui")}
          </button>
          <button
            className={mode === "json" ? "active" : ""}
            onClick={() => setMode("json")}
          >
            {t("settings.json")}
          </button>
        </div>
      </div>

      {mode === "gui" ? (
        <div>
          <Row name={t("settings.layout")} settingKey="workbench.layout">
            <select
              className="select"
              value={settings["workbench.layout"]}
              onChange={(e) =>
                set("workbench.layout", e.target.value as Settings["workbench.layout"])
              }
            >
              <option value="vscode">VS Code</option>
              <option value="cursor">Cursor</option>
            </select>
          </Row>
          <Row name={t("settings.theme")} settingKey="workbench.theme">
            <select
              className="select"
              value={settings["workbench.theme"]}
              onChange={(e) =>
                set("workbench.theme", e.target.value as Settings["workbench.theme"])
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </Row>
          <Row name={t("settings.language")} settingKey="workbench.language">
            <select
              className="select"
              value={settings["workbench.language"]}
              onChange={(e) =>
                set(
                  "workbench.language",
                  e.target.value as Settings["workbench.language"],
                )
              }
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </Row>
          <Row name={t("settings.keymap")} settingKey="workbench.keymap">
            <select
              className="select"
              value={settings["workbench.keymap"]}
              onChange={(e) =>
                set("workbench.keymap", e.target.value as Settings["workbench.keymap"])
              }
            >
              <option value="default">Default</option>
              <option value="vim">Vim</option>
              <option value="helix">Helix</option>
            </select>
            <div className="setting-keymap-help">{t("settings.keymapHelp")}</div>
          </Row>
          <Row name={t("settings.fontSize")} settingKey="editor.fontSize">
            <input
              className="field"
              type="number"
              value={settings["editor.fontSize"]}
              onChange={(e) => set("editor.fontSize", Number(e.target.value))}
            />
          </Row>
          <Row name={t("settings.tabSize")} settingKey="editor.tabSize">
            <input
              className="field"
              type="number"
              value={settings["editor.tabSize"]}
              onChange={(e) => set("editor.tabSize", Number(e.target.value))}
            />
          </Row>
          <Row name={t("settings.wordWrap")} settingKey="editor.wordWrap">
            <Switch
              on={settings["editor.wordWrap"] === "on"}
              onChange={(v) => set("editor.wordWrap", v ? "on" : "off")}
            />
          </Row>
          <Row name={t("settings.minimap")} settingKey="editor.minimap">
            <Switch
              on={settings["editor.minimap"]}
              onChange={(v) => set("editor.minimap", v)}
            />
          </Row>
          <Row name={t("settings.lineNumbers")} settingKey="editor.lineNumbers">
            <select
              className="select"
              value={settings["editor.lineNumbers"]}
              onChange={(e) =>
                set(
                  "editor.lineNumbers",
                  e.target.value as Settings["editor.lineNumbers"],
                )
              }
            >
              <option value="on">On</option>
              <option value="off">Off</option>
              <option value="relative">Relative</option>
            </select>
          </Row>
          <Row
            name={t("settings.inlineBlame")}
            settingKey="git.blame.inline.enabled"
          >
            <Switch
              on={settings["git.blame.inline.enabled"]}
              onChange={(v) => set("git.blame.inline.enabled", v)}
            />
          </Row>
          <Row
            name={t("settings.statusBarBlame")}
            settingKey="git.blame.statusBar.enabled"
          >
            <Switch
              on={settings["git.blame.statusBar.enabled"]}
              onChange={(v) => set("git.blame.statusBar.enabled", v)}
            />
          </Row>
          <Row name={t("settings.terminalFontSize")} settingKey="terminal.fontSize">
            <input
              className="field"
              type="number"
              value={settings["terminal.fontSize"]}
              onChange={(e) => set("terminal.fontSize", Number(e.target.value))}
            />
          </Row>
          <Row name={t("settings.agentRuntime")} settingKey="agent.defaultRuntime">
            <select
              className="select"
              value={settings["agent.defaultRuntime"]}
              onChange={(event) => set("agent.defaultRuntime", event.target.value)}
            >
              <option value="logos">Logos</option>
              <option value="claude">Claude</option>
              {settings["agent.acpServers"].map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} (ACP)
                </option>
              ))}
              {registry.filter((agent) => agent.available).map((agent) => (
                <option key={agent.id} value={`registry:${agent.id}`}>
                  {agent.name} {agent.version} (Registry)
                </option>
              ))}
            </select>
          </Row>
          <Row name={t("settings.acpAgents")} settingKey="agent.acpServers">
            <AcpServersEditor
              servers={settings["agent.acpServers"]}
              referencedIds={new Set(agentSessions.map((session) => session.runtimeId))}
              onChange={(servers) => {
                const currentRuntime = settings["agent.defaultRuntime"];
                return setManySettings({
                  "agent.acpServers": servers,
                  ...(
                    currentRuntime !== "claude" &&
                    currentRuntime !== "logos" &&
                    !currentRuntime.startsWith("registry:") &&
                    !servers.some((server) => server.id === currentRuntime)
                      ? {
                          "agent.defaultRuntime":
                            DEFAULT_SETTINGS["agent.defaultRuntime"],
                        }
                      : {}
                  ),
                });
              }}
            />
          </Row>
          <Row name={t("settings.acpRegistry")} settingKey="agentclientprotocol.com/registry">
            <div className="provider-login">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => void loadAgentRegistry(true)}
              >
                {t("settings.refreshRegistry")}
              </Button>
              <span>{t("settings.registryCount").replace("{count}", String(registry.length))}</span>
            </div>
          </Row>
          <Row name={t("settings.modelProviders")} settingKey="safeStorage:openai">
            <div className="provider-login">
              <div className="provider-login-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={authBusy}
                  onPress={() => void runAuth(loginChatGPT)}
                >
                  {t("settings.connectChatGPT")}
                </Button>
                {credentialStatus.type !== "none" && (
                  <Button
                    size="sm"
                    variant="danger"
                    isDisabled={authBusy}
                    onPress={() => void runAuth(logoutOpenAI)}
                  >
                    {t("settings.disconnect")}
                  </Button>
                )}
              </div>
              <span>
                {credentialStatus.type === "none"
                  ? t("settings.chatgptSubscriptionHint")
                  : `${t("settings.connectedAs")} ${credentialStatus.label ?? credentialStatus.type}`}
              </span>
              <div className="provider-key-row">
                <input
                  className="field"
                  type="password"
                  value={openAIKey}
                  placeholder="sk-..."
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setOpenAIKeyValue(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={authBusy || !openAIKey.trim()}
                  onPress={() =>
                    void runAuth(async () => {
                      await setOpenAIKey(openAIKey);
                      setOpenAIKeyValue("");
                    })
                  }
                >
                  {t("settings.useApiKey")}
                </Button>
              </div>
              {authError && <span className="provider-auth-error">{authError}</span>}
            </div>
          </Row>
          <Row name={t("settings.logosModel")} settingKey="agent.logosModel">
            <input
              className="field"
              value={settings["agent.logosModel"]}
              placeholder={DEFAULT_LOGOS_MODEL}
              spellCheck={false}
              onChange={(event) => set("agent.logosModel", event.target.value)}
            />
          </Row>
          <Row name={t("settings.openaiBaseUrl")} settingKey="agent.openaiBaseUrl">
            <input
              className="field"
              value={settings["agent.openaiBaseUrl"]}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              onChange={(event) => set("agent.openaiBaseUrl", event.target.value)}
            />
          </Row>
          <Row name={t("settings.agentPermission")} settingKey="agent.permissionMode">
            <select
              className="select"
              value={settings["agent.permissionMode"]}
              onChange={(e) =>
                set(
                  "agent.permissionMode",
                  e.target.value as Settings["agent.permissionMode"],
                )
              }
            >
              <option value="default">default (ask)</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="plan">plan</option>
              <option value="bypassPermissions">bypassPermissions</option>
            </select>
          </Row>
          <Row name={t("settings.agentApiKey")} settingKey="agent.apiKey">
            <Secret
              value={settings["agent.apiKey"]}
              placeholder="sk-ant-…"
              onChange={(v) => set("agent.apiKey", v)}
            />
          </Row>
          <Row name={t("settings.agentAuthToken")} settingKey="agent.authToken">
            <Secret
              value={settings["agent.authToken"]}
              placeholder="ANTHROPIC_AUTH_TOKEN"
              onChange={(v) => set("agent.authToken", v)}
            />
          </Row>
          <Row name={t("settings.agentBaseUrl")} settingKey="agent.baseUrl">
            <input
              className="field"
              value={settings["agent.baseUrl"]}
              placeholder="https://api.anthropic.com"
              spellCheck={false}
              onChange={(e) => set("agent.baseUrl", e.target.value)}
            />
          </Row>
          <Row name={t("settings.agentModel")} settingKey="agent.model">
            <input
              className="field"
              value={settings["agent.model"]}
              placeholder={t("agent.modelDefault")}
              spellCheck={false}
              onChange={(e) => set("agent.model", e.target.value)}
            />
          </Row>
          <Row name={t("agent.effort")} settingKey="agent.effort">
            <select
              className="select"
              value={settings["agent.effort"]}
              onChange={(e) =>
                set("agent.effort", e.target.value as Settings["agent.effort"])
              }
            >
              <option value="">{t("agent.effortAuto")}</option>
              <option value="none">none</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
          </Row>
          <Row name={t("agent.thinking")} settingKey="agent.thinking">
            <select
              className="select"
              value={settings["agent.thinking"]}
              onChange={(e) =>
                set(
                  "agent.thinking",
                  e.target.value as Settings["agent.thinking"],
                )
              }
            >
              <option value="adaptive">{t("agent.thinkingAdaptive")}</option>
              <option value="enabled">{t("agent.thinkingOn")}</option>
              <option value="disabled">{t("agent.thinkingOff")}</option>
            </select>
          </Row>
          <Row
            name={t("settings.agentThinkingBudget")}
            settingKey="agent.thinkingBudget"
          >
            <input
              className="field"
              type="number"
              value={settings["agent.thinkingBudget"]}
              onChange={(e) =>
                set("agent.thinkingBudget", Number(e.target.value))
              }
            />
          </Row>
          <Row name={t("settings.agentAllowedTools")} settingKey="agent.allowedTools">
            <input
              className="field"
              value={settings["agent.allowedTools"].join(", ")}
              placeholder="Read, Bash(npm test)"
              spellCheck={false}
              onChange={(e) =>
                set(
                  "agent.allowedTools",
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </Row>
          <Row
            name={t("settings.agentDisallowedTools")}
            settingKey="agent.disallowedTools"
          >
            <input
              className="field"
              value={settings["agent.disallowedTools"].join(", ")}
              spellCheck={false}
              onChange={(e) =>
                set(
                  "agent.disallowedTools",
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </Row>
          <Row
            name={t("settings.agentLoadProjectSettings")}
            settingKey="agent.loadProjectSettings"
          >
            <Switch
              on={settings["agent.loadProjectSettings"]}
              onChange={(v) => set("agent.loadProjectSettings", v)}
            />
          </Row>
          <Row name={t("settings.autoDownloadLsp")} settingKey="lsp.autoDownload">
            <Switch
              on={settings["lsp.autoDownload"]}
              onChange={(v) => set("lsp.autoDownload", v)}
            />
          </Row>

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              className="btn ghost"
              style={{ width: "auto" }}
              onClick={() => void resetSettings()}
            >
              {t("settings.reset")}
            </button>
          </div>
          <div style={{ marginTop: 14, fontSize: 11, color: "var(--muted)" }}>
            {t("settings.savedTo")}: <code>{path}</code>
          </div>
        </div>
      ) : (
        <div>
          <textarea
            className="field"
            style={{
              minHeight: 360,
              fontFamily: "var(--mono-font)",
              fontSize: 12,
            }}
            value={json}
            spellCheck={false}
            onChange={(e) => setJson(e.target.value)}
          />
          {jsonError && (
            <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>
              {jsonError}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="btn" style={{ width: "auto" }} onClick={applyJson}>
              {t("editor.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
