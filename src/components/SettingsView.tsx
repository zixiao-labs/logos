import { useEffect, useState } from "react";
import { Button, Card } from "@heroui/react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import type { AcpAgentConfig, Settings } from "../shared/types";

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
  onChange,
}: {
  servers: AcpAgentConfig[];
  onChange: (servers: AcpAgentConfig[]) => void;
}) {
  const update = (id: string, patch: Partial<AcpAgentConfig>) =>
    onChange(servers.map((server) => (server.id === id ? { ...server, ...patch } : server)));

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
              onPress={() => onChange(servers.filter((item) => item.id !== server.id))}
            >
              ×
            </Button>
          </Card.Header>
          <Card.Content className="acp-server-fields">
            <input
              className="field"
              aria-label="Agent id"
              placeholder="id"
              value={server.id}
              onChange={(event) => update(server.id, { id: event.target.value })}
            />
            <input
              className="field"
              aria-label="Agent name"
              placeholder="Display name"
              value={server.name}
              onChange={(event) => update(server.id, { name: event.target.value })}
            />
            <input
              className="field"
              aria-label="Agent command"
              placeholder="opencode"
              value={server.command}
              onChange={(event) => update(server.id, { command: event.target.value })}
            />
            <input
              className="field"
              aria-label="Agent arguments"
              placeholder="acp"
              value={server.args.join(" ")}
              onChange={(event) =>
                update(server.id, {
                  args: event.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
            <textarea
              className="field acp-env"
              aria-label="Agent environment"
              placeholder='{"OPENAI_API_KEY":"..."}'
              defaultValue={JSON.stringify(server.env, null, 2)}
              onBlur={(event) => {
                try {
                  const env = JSON.parse(event.target.value) as Record<string, string>;
                  update(server.id, { env });
                } catch {
                  event.target.value = JSON.stringify(server.env, null, 2);
                }
              }}
            />
          </Card.Content>
        </Card>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onPress={() =>
          onChange([
            ...servers,
            {
              id: `agent-${servers.length + 1}`,
              name: "ACP Agent",
              command: "",
              args: [],
              env: {},
            },
          ])
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
              onChange={(servers) => {
                const currentRuntime = settings["agent.defaultRuntime"];
                void setManySettings({
                  "agent.acpServers": servers,
                  ...(
                    currentRuntime !== "claude" &&
                    currentRuntime !== "logos" &&
                    !currentRuntime.startsWith("registry:") &&
                    !servers.some((server) => server.id === currentRuntime)
                      ? { "agent.defaultRuntime": "claude" }
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
              placeholder="gpt-5.4"
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
