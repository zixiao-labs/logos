import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import type { Settings } from "../shared/types";

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

export function SettingsView() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const setManySettings = useStore((s) => s.setManySettings);
  const resetSettings = useStore((s) => s.resetSettings);
  const [mode, setMode] = useState<"gui" | "json">("gui");
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [path, setPath] = useState("");

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
