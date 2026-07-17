import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Chip, Disclosure, Spinner, Switch } from "@heroui/react";
import {
  useStore,
  type AgentItem,
  type AgentThread,
  type AgentTraceEntry,
} from "../state/store";
import { useT } from "../i18n";
import { listWorkspaceFiles } from "../lib/workspaceFiles";
import type {
  AgentEffortLevel,
  AgentModelInfo,
  AgentPermissionMode,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentQuestion,
} from "../shared/types";
import {
  buildLogosAgentSystemPrompt,
  logosOpenAIModels,
  LOGOS_AGENT_TOOLS,
} from "../shared/logos-agent";
import { Icon } from "./Icon";

const ALL_EFFORT: AgentEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const ALL_OPENAI_EFFORT: AgentEffortLevel[] = [
  "none",
  ...ALL_EFFORT,
];

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
  const roots = sessions.filter((thread) => !thread.parentId);

  const renderThread = (thread: AgentThread, depth = 0) => (
    <div key={thread.id}>
      <button
        className={`agent-tab ${thread.id === active?.id ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setActiveAgent(thread.id)}
      >
        <Icon name={depth ? "branch" : "agent"} size={13} />
        <span className="thread-name">{thread.name}</span>
        {thread.status === "running" && <span className="dirty" />}
        {thread.status === "waiting" && <span className="thread-waiting">?</span>}
        <span
          className="icon-btn"
          style={{ width: 16, height: 16 }}
          onClick={(event) => {
            event.stopPropagation();
            removeAgentSession(thread.id);
          }}
        >
          <Icon name="close" size={11} />
        </span>
      </button>
      {sessions
        .filter((candidate) => candidate.parentId === thread.id)
        .map((child) => renderThread(child, depth + 1))}
    </div>
  );

  return (
    <div className="agent">
      <div className="panel-header">
          <div className="thread-heading">
            <span>{active?.name ?? t("agent.title")}</span>
            {active && (
              <Chip size="sm" variant="soft">
                {active.runtimeName ?? active.runtimeId}
              </Chip>
            )}
          </div>
        <div className="actions">
          <button
            className="icon-btn"
            title={t("agent.newAgent")}
            onClick={() => newAgentSession()}
          >
            <Icon name="add" />
          </button>
          {active && (
            <button
              className="icon-btn"
              title={t("agent.newSubthread")}
              onClick={() => newAgentSession(undefined, active.id, active.runtimeId)}
            >
              <Icon name="branch" />
            </button>
          )}
          {onClose && (
            <button className="icon-btn" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>

      {!hideSessions && sessions.length > 0 && (
        <div className="agent-tabs">
          {roots.map((thread) => renderThread(thread))}
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

function AgentConversation({ session }: { session: AgentThread }) {
  const t = useT();
  const root = useStore((s) => s.root);
  const sendAgentPrompt = useStore((s) => s.sendAgentPrompt);
  const interruptAgent = useStore((s) => s.interruptAgent);
  const globalAgentCommands = useStore((s) => s.agentCommands);
  const loadAgentModels = useStore((s) => s.loadAgentModels);
  const loadAgentCommands = useStore((s) => s.loadAgentCommands);
  const logRef = useRef<HTMLDivElement>(null);
  const timelineFollowing = useRef(true);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<{ token: string } | null>(null);
  const [slash, setSlash] = useState<{ token: string } | null>(null);

  useEffect(() => {
    if (root) void listWorkspaceFiles(root).then(setFiles);
  }, [root]);

  // D1/D4: probe the SDK for models + slash-commands once the panel is open.
  useEffect(() => {
    if (session.runtimeId === "claude") {
      void loadAgentModels();
      void loadAgentCommands();
    }
  }, [session.runtimeId, loadAgentModels, loadAgentCommands]);

  useEffect(() => {
    timelineFollowing.current = true;
  }, [session.id]);

  useEffect(() => {
    if (timelineFollowing.current) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    }
  }, [
    session.id,
    session.items,
    session.pendingAsk,
    session.pendingPermission,
    session.plan,
    session.status,
  ]);

  const deferredText = useDeferredValue(text);

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
    const commands = session.commands.length
      ? session.commands
      : session.runtimeId === "claude"
        ? globalAgentCommands
        : [];
    return commands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [slash, globalAgentCommands, session.commands, session.runtimeId]);

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
    if (!value || session.status !== "idle") return;
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
      <div
        className="agent-log"
        ref={logRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          timelineFollowing.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 72;
        }}
      >
        {session.runtimeId === "logos" && (
          <LogosRuntimeContract
            defaultExpanded={session.items.length === 0}
            mode={(session.modeId as AgentPermissionMode | undefined) ?? "default"}
            workspace={root ?? "."}
          />
        )}
        {session.items.length === 0 && !session.pendingAsk && (
          <div className="agent-empty">
            <h3>{t("agent.emptyTitle")}</h3>
            <p>{t("agent.emptyBody")}</p>
          </div>
        )}
        {session.plan.length > 0 && <PlanCard entries={session.plan} />}
        {session.trace.length > 0 && <AgentDebug trace={session.trace} />}
        {session.items
          .filter(
            (item) =>
              !("parentToolUseId" in item) || item.parentToolUseId == null,
          )
          .map((item) => (
          <AgentItemView key={item.id} item={item} allItems={session.items} />
        ))}
        {session.pendingPermission && (
          <PermissionCard
            requestId={session.pendingPermission.requestId}
            toolName={session.pendingPermission.toolName}
            input={session.pendingPermission.input}
            options={session.pendingPermission.options}
          />
        )}
        {session.pendingAsk && (
          <AskCard
            requestId={session.pendingAsk.requestId}
            questions={session.pendingAsk.questions}
          />
        )}
        {session.status === "waiting" &&
          !session.pendingAsk &&
          !session.pendingPermission &&
          session.authMethods.length > 0 && (
          <AuthCard thread={session} />
        )}
        {session.status === "running" && !session.pendingAsk && (
          <div className="agent-working" role="status" aria-live="polite">
            <Spinner color="current" size="sm" />
            <span>{t("agent.running")}</span>
          </div>
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
            <AgentControls session={session} />
            {session.status !== "idle" ? (
              <button className="send-btn stop" onClick={() => void interruptAgent()}>
                <Icon name="stop" size={13} /> {t("agent.stop")}
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={send}
                disabled={!deferredText.trim() || session.status !== "idle"}
              >
                <Icon name="send" size={13} /> {t("agent.send")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Runtime capabilities are projected into one compact Thread toolbar. */
function AgentControls({ session }: { session: AgentThread }) {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const setAgentRuntime = useStore((s) => s.setAgentRuntime);
  const setAgentMode = useStore((s) => s.setAgentMode);
  const setAgentModel = useStore((s) => s.setAgentModel);
  const setAgentConfig = useStore((s) => s.setAgentConfig);
  const toggleAgentFollow = useStore((s) => s.toggleAgentFollow);
  const liveModels = useStore((s) => s.agentModels);
  const registry = useStore((s) => s.agentRegistry);
  const credentialStatus = useStore((s) => s.agentCredentialStatus);
  const fallbackLogosModels = logosOpenAIModels(
    credentialStatus.type === "api-key" ? "api-key" : "chatgpt",
  );

  const models =
    session.runtimeId === "claude"
      ? session.models.length
        ? session.models
        : liveModels.length
          ? liveModels
          : STATIC_MODELS
      : session.runtimeId === "logos"
        ? session.models.length
          ? session.models
          : fallbackLogosModels
        : session.models;
  const model =
    session.currentModelId ??
    (session.runtimeId === "logos"
      ? settings["agent.logosModel"]
      : settings["agent.model"]);
  const selected = models.find((m) => m.value === model);
  const fallbackEffortLevels =
    session.runtimeId === "logos" ? ALL_OPENAI_EFFORT : ALL_EFFORT;
  // Default (no model) => all effort levels; a specific model => its own.
  const effortLevels = model
    ? selected?.supportsEffort === false
      ? []
      : (selected?.supportedEffortLevels ?? fallbackEffortLevels)
    : fallbackEffortLevels;
  const effortValue = settings["agent.effort"];
  const selectedEffort =
    !effortValue || effortLevels.includes(effortValue) ? effortValue : "";

  return (
    <div className="agent-controls">
      <select
        className="agent-mini runtime"
        title={t("agent.runtime")}
        value={session.runtimeId}
        disabled={Boolean(session.sdkSessionId) || session.items.length > 0}
        onChange={(event) => setAgentRuntime(session.id, event.target.value)}
      >
        <option value="logos">Logos</option>
        <option value="claude">Claude</option>
        <optgroup label="Configured ACP">
          {settings["agent.acpServers"].map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="ACP Registry">
          {registry.map((agent) => (
            <option
              key={agent.id}
              value={`registry:${agent.id}`}
              disabled={!agent.available}
            >
              {agent.name} {agent.version}
            </option>
          ))}
        </optgroup>
      </select>

      {(session.runtimeId === "claude" || session.runtimeId === "logos" || models.length > 0) && (
        <select
          className="agent-mini"
          title={t("agent.model")}
          value={model}
          onChange={(event) =>
            !session.sdkSessionId && session.runtimeId === "claude"
              ? void setSetting("agent.model", event.target.value)
              : !session.sdkSessionId && session.runtimeId === "logos"
                ? void setSetting("agent.logosModel", event.target.value)
                : void setAgentModel(session.id, event.target.value)
          }
        >
          <option value="">{t("agent.modelDefault")}</option>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName}
            </option>
          ))}
        </select>
      )}

      {(session.modes.length > 0 || session.runtimeId === "claude" || session.runtimeId === "logos") && (
        <select
          className={`agent-mini ${session.modeId === "plan" ? "plan" : ""}`}
          title={t("agent.mode")}
          value={session.modeId ?? "default"}
          onChange={(event) =>
            void setAgentMode(session.id, event.target.value)
          }
        >
          {(session.modes.length
            ? session.modes
            : [
                { id: "default", name: t("agent.buildMode") },
                { id: "plan", name: t("agent.planMode") },
                { id: "acceptEdits", name: "Accept edits" },
              ]
          ).map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
      )}

      {session.configOptions.map((option) =>
        option.type === "select" ? (
          <select
            key={option.id}
            className="agent-mini"
            title={option.description ?? option.name}
            value={option.currentValue}
            onChange={(event) =>
              void setAgentConfig(session.id, option.id, event.target.value)
            }
          >
            {option.options.map((value) => (
              <option key={value.value} value={value.value}>
                {value.group ? `${value.group}: ` : ""}
                {value.name}
              </option>
            ))}
          </select>
        ) : (
          <Switch
            key={option.id}
            aria-label={option.name}
            isSelected={option.currentValue}
            size="sm"
            onChange={(value) =>
              void setAgentConfig(session.id, option.id, value)
            }
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        ),
      )}

      {(session.runtimeId === "claude" || session.runtimeId === "logos") &&
        effortLevels.length > 0 && (
        <select
          className="agent-mini"
          title={t("agent.effort")}
          value={selectedEffort}
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

      {session.runtimeId === "claude" && (
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
      )}

      <Button
        isIconOnly
        aria-label={
          session.followMode ? t("agent.followOn") : t("agent.followOff")
        }
        className={`agent-follow ${session.followMode ? "active" : ""}`}
        size="sm"
        variant="ghost"
        onPress={() => toggleAgentFollow(session.id)}
      >
        <Icon name="preview" size={12} />
      </Button>
    </div>
  );
}

/** Detects whether an agent error is an authentication failure (F3). */
function isAuthError(message: string): boolean {
  return /401|unauthor|authenticat|api[\s_-]?key|credit balance|x-api-key|ANTHROPIC_/i.test(
    message,
  );
}

function PlanCard({ entries }: { entries: AgentPlanEntry[] }) {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  return (
    <Disclosure defaultExpanded>
      <Disclosure.Heading>
        <Disclosure.Trigger className="plan-head">
          <Icon name="check" size={13} />
          <span>Plan</span>
          <span className="plan-count">
            {completed}/{entries.length}
          </span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="plan-body">
          {entries.map((entry, index) => (
            <div key={`${index}:${entry.content}`} className={`plan-row ${entry.status}`}>
              <span className="plan-mark">
                {entry.status === "completed"
                  ? "✓"
                  : entry.status === "in_progress"
                    ? "●"
                    : "○"}
              </span>
              <span>{entry.content}</span>
              {entry.priority === "high" && (
                <Chip color="warning" size="sm" variant="soft">
                  high
                </Chip>
              )}
            </div>
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function AuthCard({ thread }: { thread: AgentThread }) {
  const t = useT();
  const authenticateAgent = useStore((state) => state.authenticateAgent);
  const openSpecial = useStore((state) => state.openSpecial);
  return (
    <div className="auth-card">
      <div className="auth-title">{t("agent.authRequired")}</div>
      {thread.authMethods.map((method) => (
        <Button
          key={method.id}
          size="sm"
          variant="secondary"
          onPress={() =>
            method.type === "env_var"
              ? openSpecial("settings")
              : void authenticateAgent(thread.id, method.id)
          }
        >
          <Icon name={method.type === "terminal" ? "terminal" : "globe"} size={13} />
          {method.name}
        </Button>
      ))}
    </div>
  );
}

function AgentDebug({ trace }: { trace: AgentTraceEntry[] }) {
  const recent = trace.slice(-50).reverse();
  return (
    <Disclosure className="agent-debug">
      <Disclosure.Heading>
        <Disclosure.Trigger className="agent-debug-head">
          <Icon name="debug" size={13} />
          <span>Agent Debug</span>
          <Chip size="sm" variant="soft">{trace.length}</Chip>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="agent-debug-body">
          {recent.map((entry) => (
            <div className="agent-debug-entry" key={entry.id}>
              <div>
                <time>{new Date(entry.time).toLocaleTimeString()}</time>
                <strong>{entry.subtype}</strong>
              </div>
              <pre>{stringifyDebugData(entry.data)}</pre>
            </div>
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function LogosRuntimeContract({
  defaultExpanded,
  mode,
  workspace,
}: {
  defaultExpanded: boolean;
  mode: AgentPermissionMode;
  workspace: string;
}) {
  const t = useT();
  const prompt = buildLogosAgentSystemPrompt({ workspace, mode });
  return (
    <Disclosure className="agent-runtime-contract" defaultExpanded={defaultExpanded}>
      <Disclosure.Heading>
        <Disclosure.Trigger className="agent-runtime-contract-head">
          <Icon name="agent" size={13} />
          <span>{t("agent.runtimeContract")}</span>
          <Chip size="sm" variant="soft">
            {t("agent.toolCount").replace("{count}", String(LOGOS_AGENT_TOOLS.length))}
          </Chip>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="agent-runtime-contract-body">
          <section>
            <h4>{t("agent.toolList")}</h4>
            <div className="agent-tool-list">
              {LOGOS_AGENT_TOOLS.map((tool) => (
                <div className="agent-tool-row" key={tool.name}>
                  <div>
                    <code>{tool.name}</code>
                    <strong>{tool.title}</strong>
                    {tool.mutating && (
                      <Chip color="warning" size="sm" variant="soft">
                        {t("agent.approval")}
                      </Chip>
                    )}
                  </div>
                  <p>{tool.description}</p>
                  <small>{tool.constraints}</small>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h4>{t("agent.systemPrompt")}</h4>
            <pre>{prompt}</pre>
          </section>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function stringifyDebugData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function AgentItemView({
  item,
  allItems,
}: {
  item: AgentItem;
  allItems: AgentItem[];
}) {
  const [open, setOpen] = useState(false);
  const openSpecial = useStore((s) => s.openSpecial);
  const t = useT();
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return (
        <div className={item.parentToolUseId ? "nested-agent-message" : undefined}>
          {item.thinking && (
            <div className="msg thinking">{item.thinking}</div>
          )}
          {item.text && <div className="msg assistant">{item.text}</div>}
        </div>
      );
    case "tool":
      const nested = allItems.filter(
        (candidate) =>
          "parentToolUseId" in candidate &&
          candidate.parentToolUseId === item.toolUseId,
      );
      return (
        <div className={`tool-call ${item.isError ? "error" : ""}`}>
          <div
            className="head"
            style={{ cursor: "pointer" }}
            onClick={() => setOpen((o) => !o)}
          >
            {item.status === "pending" || item.status === "in_progress" ? (
              <Spinner color="current" size="sm" />
            ) : (
              <Icon name={item.isError ? "error" : "terminal"} size={13} />
            )}
            {item.name}
            {item.status && (
              <Chip
                color={
                  item.status === "failed"
                    ? "danger"
                    : item.status === "completed"
                      ? "success"
                      : "default"
                }
                size="sm"
                variant="soft"
              >
                {item.status}
              </Chip>
            )}
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
              {item.diffs?.map((diff) => (
                <div key={diff.path} className="agent-tool-diff">
                  <strong>{diff.path}</strong>
                  <span>
                    -{diff.oldText.split("\n").length} +{diff.newText.split("\n").length}
                  </span>
                </div>
              ))}
              {nested.length > 0 && (
                <div className="subagent-transcript">
                  {nested.map((candidate) => (
                    <AgentItemView
                      key={candidate.id}
                      item={candidate}
                      allItems={allItems}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      );
    case "subagent":
      return (
        <div className="subagent-card">
          <Icon name="branch" size={13} />
          <div className="subagent-copy">
            <strong>{item.agentType ?? t("agent.subagent")}</strong>
            <span>{item.summary ?? item.description}</span>
          </div>
          <Chip
            color={
              item.status === "failed"
                ? "danger"
                : item.status === "completed"
                  ? "success"
                  : "accent"
            }
            size="sm"
            variant="soft"
          >
            {item.status}
          </Chip>
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
  options,
}: {
  requestId: string;
  toolName: string;
  input: unknown;
  options?: AgentPermissionOption[];
}) {
  const t = useT();
  const respondPermission = useStore((s) => s.respondPermission);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const highRisk = toolName === "Bash" || toolName === "MCP" || toolName === "DAP_REPL";
  const summary = highRisk
    ? stringifyDebugData(input)
    : ((input as { command?: string; file_path?: string; path?: string })?.command ??
      (input as { file_path?: string; path?: string })?.file_path ??
      (input as { path?: string })?.path ??
      stringifyDebugData(input));

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
          whiteSpace: "pre-wrap",
          maxHeight: 180,
          overflow: "auto",
        }}
      >
        {String(summary)}
      </div>
      <div className="perm-actions">
        {options?.length ? (
          options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.kind.startsWith("reject") ? "tertiary" : "secondary"}
              onPress={() =>
                void respondPermission(
                  requestId,
                  option.kind.startsWith("allow") ? "allow" : "deny",
                  option.id,
                )
              }
            >
              {option.id === "allow-once"
                ? t("agent.allowOnce")
                : option.id === "reject-once"
                  ? t("agent.deny")
                  : option.name}
            </Button>
          ))
        ) : (
          <>
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
          </>
        )}
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
  const [answers, setAnswers] = useState<
    Record<number, string | string[] | number | boolean>
  >(() =>
    Object.fromEntries(
      questions.flatMap((question, index) =>
        question.defaultValue === undefined
          ? []
          : [[index, question.defaultValue]],
      ),
    ),
  );
  const [other, setOther] = useState<Record<number, string>>({});

  function selectOption(qi: number, value: string, multi: boolean) {
    setAnswers((prev) => {
      if (!multi) return { ...prev, [qi]: value };
      const cur = Array.isArray(prev[qi]) ? (prev[qi] as string[]) : [];
      const next = cur.includes(value)
        ? cur.filter((item) => item !== value)
        : [...cur, value];
      return { ...prev, [qi]: next };
    });
  }

  function isSelected(qi: number, value: string): boolean {
    const a = answers[qi];
    return Array.isArray(a) ? a.includes(value) : a === value;
  }

  const complete = questions.every((question, i) => {
    if (!question.required) return true;
    const a = answers[i];
    const hasOther = (other[i] ?? "").trim().length > 0;
    if (Array.isArray(a)) return a.length > 0 || hasOther;
    return (a != null && a !== "") || hasOther;
  });

  function submit() {
    const map: Record<string, string | string[] | number | boolean> = {};
    questions.forEach((q, i) => {
      const otherText = (other[i] ?? "").trim();
      let value = answers[i];
      if (!q.required && value == null && !otherText) return;
      if (Array.isArray(value)) {
        value = otherText ? [...value, otherText] : value;
      } else if (otherText && q.options.length > 0) {
        value = otherText;
      }
      if (value != null && value !== "") map[q.id ?? q.question] = value;
    });
    void answerAsk(requestId, map);
  }

  return (
    <div className="ask-card">
      {questions.map((q, qi) => (
        <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="ask-header">{q.header}</div>
          <div className="ask-q">{q.question}</div>
          {q.type === "url" && q.url && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                void window.logos.app.openExternal(q.url!);
                setAnswers((previous) => ({ ...previous, [qi]: q.url! }));
              }}
            >
              <Icon name="globe" size={13} /> {t("agent.openBrowser")}
            </Button>
          )}
          {q.type === "boolean" && (
            <div className="ask-boolean">
              {[true, false].map((value) => (
                <button
                  key={String(value)}
                  className={`ask-opt ${answers[qi] === value ? "selected" : ""}`}
                  onClick={() =>
                    setAnswers((previous) => ({ ...previous, [qi]: value }))
                  }
                >
                  {value ? t("agent.yes") : t("agent.no")}
                </button>
              ))}
            </div>
          )}
          {q.options.map((opt) => (
            <button
              key={opt.label}
              className={`ask-opt ${isSelected(qi, opt.value ?? opt.label) ? "selected" : ""}`}
              onClick={() =>
                selectOption(qi, opt.value ?? opt.label, q.multiSelect)
              }
            >
              <span className="label">{opt.label}</span>
              <span className="desc">{opt.description}</span>
              {opt.preview && <div className="ask-preview">{opt.preview}</div>}
            </button>
          ))}
          {q.type !== "url" && q.type !== "boolean" && q.allowCustom !== false && (
            <input
              className="field"
              type={q.type === "number" ? "number" : "text"}
              placeholder={q.options.length ? "Other…" : t("agent.answer")}
              value={other[qi] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setOther((previous) => ({ ...previous, [qi]: value }));
                if (!q.options.length) {
                  setAnswers((previous) => ({
                    ...previous,
                    [qi]: q.type === "number" && value !== "" ? Number(value) : value,
                  }));
                }
              }}
            />
          )}
        </div>
      ))}
      <button className="btn" disabled={!complete} onClick={submit}>
        {t("common.confirm")}
      </button>
      <button
        className="btn ghost"
        onClick={() => void answerAsk(requestId, {}, undefined, "cancel")}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
