import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type AgentItem, type AgentSession } from "../state/store";
import { useT } from "../i18n";
import { listWorkspaceFiles } from "../lib/workspaceFiles";
import type {
  AgentEffortLevel,
  AgentModelInfo,
  AgentQuestion,
} from "../shared/types";
import { Icon } from "./Icon";

const ALL_EFFORT: AgentEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Static fallback model list so the picker is usable before (or without) a
 * live `supportedModels()` probe. Replaced by live data once it arrives.
 */
const STATIC_MODELS: AgentModelInfo[] = [
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Most capable",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Balanced",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest",
  },
];

export function AgentPanel({
  onClose,
  hideSessions,
}: {
  onClose?: () => void;
  hideSessions?: boolean;
}) {
  const t = useT();
  const sessions = useStore((s) => s.agentSessions);
  const activeAgentId = useStore((s) => s.activeAgentId);
  const setActiveAgent = useStore((s) => s.setActiveAgent);
  const newAgentSession = useStore((s) => s.newAgentSession);
  const removeAgentSession = useStore((s) => s.removeAgentSession);

  const active = sessions.find((a) => a.id === activeAgentId) ?? sessions[0] ?? null;

  return (
    <div className="agent">
      <div className="panel-header">
        <span>{active?.name ?? t("agent.title")}</span>
        <div className="actions">
          <button
            className="icon-btn"
            title={t("agent.newAgent")}
            onClick={() => newAgentSession()}
          >
            <Icon name="add" />
          </button>
          {onClose && (
            <button className="icon-btn" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>

      {!hideSessions && sessions.length > 1 && (
        <div className="agent-tabs">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`agent-tab ${s.id === active?.id ? "active" : ""}`}
              onClick={() => setActiveAgent(s.id)}
            >
              <Icon name="agent" size={13} />
              {s.name}
              {s.status === "running" && <span className="dirty" />}
              <span
                className="icon-btn"
                style={{ width: 16, height: 16 }}
                onClick={(e) => {
                  e.stopPropagation();
                  removeAgentSession(s.id);
                }}
              >
                <Icon name="close" size={11} />
              </span>
            </button>
          ))}
        </div>
      )}

      {active ? (
        <AgentConversation session={active} />
      ) : (
        <div className="agent-log">
          <div className="agent-empty">
            <h3>{t("agent.emptyTitle")}</h3>
            <p>{t("agent.emptyBody")}</p>
            <button className="btn" onClick={() => newAgentSession()}>
              {t("agent.newAgent")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentConversation({ session }: { session: AgentSession }) {
  const t = useT();
  const root = useStore((s) => s.root);
  const sendAgentPrompt = useStore((s) => s.sendAgentPrompt);
  const interruptAgent = useStore((s) => s.interruptAgent);
  const agentCommands = useStore((s) => s.agentCommands);
  const loadAgentModels = useStore((s) => s.loadAgentModels);
  const loadAgentCommands = useStore((s) => s.loadAgentCommands);
  const logRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<{ token: string } | null>(null);
  const [slash, setSlash] = useState<{ token: string } | null>(null);

  useEffect(() => {
    if (root) void listWorkspaceFiles(root).then(setFiles);
  }, [root]);

  // D1/D4: probe the SDK for models + slash-commands once the panel is open.
  useEffect(() => {
    void loadAgentModels();
    void loadAgentCommands();
  }, [loadAgentModels, loadAgentCommands]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [session.items, session.pendingAsk, session.pendingPermission]);

  const mentionMatches = useMemo(() => {
    if (!mention || !root) return [];
    const q = mention.token.toLowerCase();
    return files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 6)
      .map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f));
  }, [mention, files, root]);

  const slashMatches = useMemo(() => {
    if (!slash) return [];
    const q = slash.token.toLowerCase();
    return agentCommands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [slash, agentCommands]);

  function onChange(value: string) {
    setText(value);
    const m = /(?:^|\s)@(\S*)$/.exec(value);
    setMention(m ? { token: m[1] } : null);
    // D4: a leading "/word" opens the slash-command menu.
    const sl = /^\/(\w*)$/.exec(value);
    setSlash(sl ? { token: sl[1] } : null);
  }

  function pickMention(rel: string) {
    setText((prev) => prev.replace(/@(\S*)$/, `@${rel} `));
    setMention(null);
  }

  function pickSlash(name: string) {
    setText(`/${name} `);
    setSlash(null);
  }

  function send() {
    const value = text.trim();
    if (!value || session.status === "running") return;
    void sendAgentPrompt(value);
    setText("");
    setMention(null);
    setSlash(null);
  }

  const menuOpen =
    (mention && mentionMatches.length > 0) ||
    (slash && slashMatches.length > 0);

  return (
    <>
      <div className="agent-log" ref={logRef}>
        {session.items.length === 0 && !session.pendingAsk && (
          <div className="agent-empty">
            <h3>{t("agent.emptyTitle")}</h3>
            <p>{t("agent.emptyBody")}</p>
          </div>
        )}
        {session.items.map((item) => (
          <AgentItemView key={item.id} item={item} />
        ))}
        {session.pendingPermission && (
          <PermissionCard
            requestId={session.pendingPermission.requestId}
            toolName={session.pendingPermission.toolName}
            input={session.pendingPermission.input}
          />
        )}
        {session.pendingAsk && (
          <AskCard
            requestId={session.pendingAsk.requestId}
            questions={session.pendingAsk.questions}
          />
        )}
        {session.status === "running" && !session.pendingAsk && (
          <div className="agent-result">{t("agent.running")}</div>
        )}
      </div>

      <div className="agent-input">
        <div className="agent-input-box">
          {mention && mentionMatches.length > 0 && (
            <div className="agent-menu">
              {mentionMatches.map((rel) => (
                <div
                  key={rel}
                  className="search-result"
                  onClick={() => pickMention(rel)}
                >
                  <Icon name="file" size={12} /> {rel}
                </div>
              ))}
            </div>
          )}
          {slash && slashMatches.length > 0 && (
            <div className="agent-menu">
              {slashMatches.map((c) => (
                <div
                  key={c.name}
                  className="search-result slash"
                  onClick={() => pickSlash(c.name)}
                >
                  <Icon name="terminal" size={12} />
                  <span className="cmd">/{c.name}</span>
                  {c.argumentHint && <span className="hint">{c.argumentHint}</span>}
                  <span className="desc">{c.description}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={text}
            placeholder={t("agent.placeholder")}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !menuOpen) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="agent-input-row">
            <AgentControls />
            {session.status === "running" ? (
              <button className="send-btn stop" onClick={() => void interruptAgent()}>
                <Icon name="stop" size={13} /> {t("agent.stop")}
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!text.trim()}>
                <Icon name="send" size={13} /> {t("agent.send")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** D1–D3: compact model / effort / thinking / permission controls. */
function AgentControls() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const liveModels = useStore((s) => s.agentModels);

  const models = liveModels.length ? liveModels : STATIC_MODELS;
  const model = settings["agent.model"];
  const selected = models.find((m) => m.value === model);
  // Default (no model) => all effort levels; a specific model => its own.
  const effortLevels = model
    ? selected?.supportsEffort === false
      ? []
      : (selected?.supportedEffortLevels ?? ALL_EFFORT)
    : ALL_EFFORT;

  return (
    <div className="agent-controls">
      <select
        className="agent-mini"
        title={t("agent.model")}
        value={model}
        onChange={(e) => void setSetting("agent.model", e.target.value)}
      >
        <option value="">{t("agent.modelDefault")}</option>
        {models.map((m) => (
          <option key={m.value} value={m.value}>
            {m.displayName}
          </option>
        ))}
      </select>

      {effortLevels.length > 0 && (
        <select
          className="agent-mini"
          title={t("agent.effort")}
          value={settings["agent.effort"]}
          onChange={(e) =>
            void setSetting(
              "agent.effort",
              e.target.value as typeof settings["agent.effort"],
            )
          }
        >
          <option value="">{t("agent.effortAuto")}</option>
          {effortLevels.map((lvl) => (
            <option key={lvl} value={lvl}>
              {lvl}
            </option>
          ))}
        </select>
      )}

      <select
        className="agent-mini"
        title={t("agent.thinking")}
        value={settings["agent.thinking"]}
        onChange={(e) =>
          void setSetting(
            "agent.thinking",
            e.target.value as typeof settings["agent.thinking"],
          )
        }
      >
        <option value="adaptive">{t("agent.thinkingAdaptive")}</option>
        <option value="enabled">{t("agent.thinkingOn")}</option>
        <option value="disabled">{t("agent.thinkingOff")}</option>
      </select>

      <select
        className="agent-mini"
        title={t("settings.agentPermission")}
        value={settings["agent.permissionMode"]}
        onChange={(e) =>
          void setSetting(
            "agent.permissionMode",
            e.target.value as typeof settings["agent.permissionMode"],
          )
        }
      >
        <option value="default">{t("agent.permDefault")}</option>
        <option value="acceptEdits">acceptEdits</option>
        <option value="plan">plan</option>
        <option value="bypassPermissions">bypass</option>
      </select>
    </div>
  );
}

/** Detects whether an agent error is an authentication failure (F3). */
function isAuthError(message: string): boolean {
  return /401|unauthor|authenticat|api[\s_-]?key|credit balance|x-api-key|ANTHROPIC_/i.test(
    message,
  );
}

function AgentItemView({ item }: { item: AgentItem }) {
  const [open, setOpen] = useState(false);
  const openSpecial = useStore((s) => s.openSpecial);
  const t = useT();
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return (
        <div>
          {item.thinking && (
            <div className="msg thinking">{item.thinking}</div>
          )}
          {item.text && <div className="msg assistant">{item.text}</div>}
        </div>
      );
    case "tool":
      return (
        <div className={`tool-call ${item.isError ? "error" : ""}`}>
          <div
            className="head"
            style={{ cursor: "pointer" }}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name={item.isError ? "error" : "terminal"} size={13} />
            {item.name}
            <span style={{ flex: 1 }} />
            <Icon name={open ? "chevron-down" : "chevron-right"} size={13} />
          </div>
          {open && (
            <div className="body">
              {JSON.stringify(item.input, null, 2)}
              {item.result != null && (
                <>
                  {"\n— — —\n"}
                  {item.result.slice(0, 4000)}
                </>
              )}
            </div>
          )}
        </div>
      );
    case "result":
      return (
        <div className="agent-result">
          {(item.durationMs / 1000).toFixed(1)}s
          {item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ""}
        </div>
      );
    case "error":
      return (
        <div className="agent-error">
          <Icon name="error" size={13} /> {item.message}
          {isAuthError(item.message) && (
            <div className="agent-error-action">
              <button
                className="btn"
                style={{ width: "auto" }}
                onClick={() => openSpecial("settings")}
              >
                {t("agent.setApiKey")}
              </button>
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
}

function PermissionCard({
  requestId,
  toolName,
  input,
}: {
  requestId: string;
  toolName: string;
  input: unknown;
}) {
  const t = useT();
  const respondPermission = useStore((s) => s.respondPermission);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const summary =
    (input as { command?: string; file_path?: string })?.command ??
    (input as { file_path?: string })?.file_path ??
    JSON.stringify(input);

  function alwaysAllow() {
    const allowed = settings["agent.allowedTools"];
    if (!allowed.includes(toolName))
      void setSetting("agent.allowedTools", [...allowed, toolName]);
    void respondPermission(requestId, "allow");
  }

  return (
    <div className="perm-card">
      <div>
        <strong>{toolName}</strong> {t("agent.permissionAsk")}
      </div>
      <div
        className="body"
        style={{
          fontFamily: "var(--mono-font)",
          fontSize: 12,
          wordBreak: "break-word",
        }}
      >
        {String(summary).slice(0, 500)}
      </div>
      <div className="perm-actions">
        <button
          className="btn"
          onClick={() => void respondPermission(requestId, "allow")}
        >
          {t("agent.allow")}
        </button>
        <button className="btn secondary" onClick={alwaysAllow}>
          {t("agent.alwaysAllow")}
        </button>
        <button
          className="btn ghost"
          onClick={() => void respondPermission(requestId, "deny")}
        >
          {t("agent.deny")}
        </button>
      </div>
    </div>
  );
}

/** Renders Claude's AskUserQuestion clarifying questions and collects answers. */
function AskCard({
  requestId,
  questions,
}: {
  requestId: string;
  questions: AgentQuestion[];
}) {
  const t = useT();
  const answerAsk = useStore((s) => s.answerAsk);
  // answers[i] holds either a label, an array of labels (multiSelect), or free text.
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  function selectOption(qi: number, label: string, multi: boolean) {
    setAnswers((prev) => {
      if (!multi) return { ...prev, [qi]: label };
      const cur = Array.isArray(prev[qi]) ? (prev[qi] as string[]) : [];
      const next = cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label];
      return { ...prev, [qi]: next };
    });
  }

  function isSelected(qi: number, label: string): boolean {
    const a = answers[qi];
    return Array.isArray(a) ? a.includes(label) : a === label;
  }

  const complete = questions.every((_q, i) => {
    const a = answers[i];
    const hasOther = (other[i] ?? "").trim().length > 0;
    if (Array.isArray(a)) return a.length > 0 || hasOther;
    return (a != null && a !== "") || hasOther;
  });

  function submit() {
    const map: Record<string, string | string[]> = {};
    questions.forEach((q, i) => {
      const otherText = (other[i] ?? "").trim();
      let value = answers[i];
      if (Array.isArray(value)) {
        value = otherText ? [...value, otherText] : value;
      } else if (otherText) {
        value = otherText;
      }
      map[q.question] = value ?? otherText;
    });
    void answerAsk(requestId, map);
  }

  return (
    <div className="ask-card">
      {questions.map((q, qi) => (
        <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="ask-header">{q.header}</div>
          <div className="ask-q">{q.question}</div>
          {q.options.map((opt) => (
            <button
              key={opt.label}
              className={`ask-opt ${isSelected(qi, opt.label) ? "selected" : ""}`}
              onClick={() => selectOption(qi, opt.label, q.multiSelect)}
            >
              <span className="label">{opt.label}</span>
              <span className="desc">{opt.description}</span>
              {opt.preview && <div className="ask-preview">{opt.preview}</div>}
            </button>
          ))}
          <input
            className="field"
            placeholder="Other…"
            value={other[qi] ?? ""}
            onChange={(e) => setOther((p) => ({ ...p, [qi]: e.target.value }))}
          />
        </div>
      ))}
      <button className="btn" disabled={!complete} onClick={submit}>
        {t("common.confirm")}
      </button>
    </div>
  );
}
