import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { useStore } from "../state/store";
import type {
  DapScope,
  DapVariable,
  DebugLaunchConfiguration,
} from "../shared/dap";
import { Icon } from "./Icon";

function sessionCanRun(status: string | undefined): boolean {
  return !status || status === "terminated" || status === "error";
}

function VariableRow({ variable, depth = 0 }: { variable: DapVariable; depth?: number }) {
  const variables = useStore((state) => state.debug.variables);
  const loadVariables = useStore((state) => state.loadDebugVariables);
  const [expanded, setExpanded] = useState(false);
  const children = variables[variable.variablesReference] ?? [];
  const expandable = variable.variablesReference !== 0;

  const toggle = () => {
    if (!expandable) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !variables[variable.variablesReference]) {
      void loadVariables(variable.variablesReference);
    }
  };

  return (
    <>
      <div
        className="debug-tree-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
        title={variable.evaluateName ?? variable.name}
      >
        <span className="debug-tree-chevron">
          {expandable ? (
            <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
          ) : null}
        </span>
        <span className="debug-variable-name">{variable.name}</span>
        <span className="debug-variable-value">{variable.value}</span>
        {variable.type && <span className="debug-variable-type">{variable.type}</span>}
      </div>
      {expanded &&
        children.map((child, index) => (
          <VariableRow
            key={`${child.name}:${index}`}
            variable={child}
            depth={depth + 1}
          />
        ))}
    </>
  );
}

function ScopeView({ scope }: { scope: DapScope }) {
  const variables = useStore(
    (state) => state.debug.variables[scope.variablesReference],
  );
  const loadVariables = useStore((state) => state.loadDebugVariables);
  const [expanded, setExpanded] = useState(!scope.expensive);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !variables) void loadVariables(scope.variablesReference);
  };

  return (
    <div>
      <button className="debug-scope-title" onClick={toggle}>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
        {scope.name}
      </button>
      {expanded &&
        (variables ?? []).map((variable, index) => (
          <VariableRow
            key={`${variable.name}:${index}`}
            variable={variable}
          />
        ))}
    </div>
  );
}

export function DebugSidebar() {
  const t = useT();
  const debug = useStore((state) => state.debug);
  const root = useStore((state) => state.root);
  const startDebug = useStore((state) => state.startDebug);
  const stopDebug = useStore((state) => state.stopDebug);
  const debugContinue = useStore((state) => state.debugContinue);
  const debugPause = useStore((state) => state.debugPause);
  const debugStep = useStore((state) => state.debugStep);
  const loadConfigurations = useStore((state) => state.loadDebugConfigurations);
  const createConfiguration = useStore((state) => state.createDebugConfiguration);
  const selectThread = useStore((state) => state.selectDebugThread);
  const selectFrame = useStore((state) => state.selectDebugFrame);
  const toggleBreakpoint = useStore((state) => state.toggleBreakpoint);
  const openFile = useStore((state) => state.openFile);
  const [configurationName, setConfigurationName] = useState("");

  useEffect(() => {
    if (
      !debug.configurations.some(
        (configuration) => configuration.name === configurationName,
      )
    ) {
      setConfigurationName(debug.configurations[0]?.name ?? "");
    }
  }, [configurationName, debug.configurations]);

  const configuration = debug.configurations.find(
    (item) => item.name === configurationName,
  );
  const session = debug.activeSessionId
    ? debug.sessions[debug.activeSessionId]
    : undefined;
  const stopped = session?.status === "stopped";
  const activeAdapter = useMemo(
    () => debug.adapters.find((adapter) => adapter.type === configuration?.type),
    [configuration?.type, debug.adapters],
  );

  const run = (selected?: DebugLaunchConfiguration) => {
    void startDebug(selected ?? configuration);
  };

  return (
    <div className="sidepanel debug-sidebar" style={{ width: "100%" }}>
      <div className="panel-header">
        <span>{t("debug.title")}</span>
        <div className="actions">
          <button
            className="icon-btn"
            title={t("debug.reloadConfigurations")}
            onClick={() => void loadConfigurations()}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="icon-btn"
            title={t("debug.openConfiguration")}
            onClick={() => void createConfiguration()}
          >
            <Icon name="settings" size={14} />
          </button>
        </div>
      </div>

      <div className="debug-launch-row">
        {debug.configurations.length ? (
          <select
            className="select"
            value={configurationName}
            onChange={(event) => setConfigurationName(event.target.value)}
          >
            {debug.configurations.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        ) : (
          <button
            className="btn secondary"
            disabled={!root}
            onClick={() => void createConfiguration()}
          >
            {t("debug.createConfiguration")}
          </button>
        )}
        {sessionCanRun(session?.status) ? (
          <button
            className="icon-btn debug-run"
            title={t("debug.start")}
            disabled={!configuration}
            onClick={() => run()}
          >
            <Icon name="play" fill size={15} />
          </button>
        ) : (
          <div className="debug-toolbar">
            {stopped ? (
              <button className="icon-btn" title={t("debug.continue")} onClick={() => void debugContinue()}>
                <Icon name="play" fill size={14} />
              </button>
            ) : (
              <button className="icon-btn" title={t("debug.pause")} onClick={() => void debugPause()}>
                <Icon name="pause" size={14} />
              </button>
            )}
            {stopped && (
              <>
                <button className="icon-btn" title={t("debug.stepOver")} onClick={() => void debugStep("next")}>
                  <Icon name="step-over" size={14} />
                </button>
                <button className="icon-btn" title={t("debug.stepInto")} onClick={() => void debugStep("stepIn")}>
                  <Icon name="step-into" size={14} />
                </button>
                <button className="icon-btn" title={t("debug.stepOut")} onClick={() => void debugStep("stepOut")}>
                  <Icon name="step-out" size={14} />
                </button>
              </>
            )}
            <button className="icon-btn debug-stop" title={t("debug.stop")} onClick={() => void stopDebug()}>
              <Icon name="stop" fill size={13} />
            </button>
          </div>
        )}
      </div>

      {activeAdapter && !activeAdapter.available && !configuration?.adapter && (
        <div className="debug-notice">
          <Icon name="warning" size={13} />
          <span>{activeAdapter.message}</span>
        </div>
      )}
      {debug.configurationError && (
        <div className="debug-notice error">
          <Icon name="error" size={13} />
          <span>{debug.configurationError}</span>
        </div>
      )}
      {session && (
        <div className={`debug-session-status ${session.status}`}>
          <span className="debug-status-dot" />
          <span>{session.name}</span>
          <span className="debug-status-label">
            {debug.stoppedReason ?? t(`debug.status.${session.status}`)}
          </span>
        </div>
      )}

      <div className="scroll-y">
        <section className="debug-section">
          <div className="debug-section-title">{t("debug.variables")}</div>
          {debug.scopes.length === 0 ? (
            <div className="debug-empty">{stopped ? t("debug.noVariables") : t("debug.notStopped")}</div>
          ) : (
            debug.scopes.map((scope) => (
              <ScopeView
                key={`${scope.name}:${scope.variablesReference}`}
                scope={scope}
              />
            ))
          )}
        </section>

        <section className="debug-section">
          <div className="debug-section-title">{t("debug.callStack")}</div>
          {debug.threads.length > 1 && (
            <select
              className="select debug-thread-select"
              value={debug.selectedThreadId ?? ""}
              onChange={(event) => void selectThread(Number(event.target.value))}
            >
              {debug.threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.name}
                </option>
              ))}
            </select>
          )}
          {debug.stackFrames.length === 0 ? (
            <div className="debug-empty">{t("debug.noCallStack")}</div>
          ) : (
            debug.stackFrames.map((frame) => (
              <button
                key={frame.id}
                className={`debug-frame ${frame.id === debug.selectedFrameId ? "active" : ""}`}
                onClick={() => void selectFrame(frame.id)}
              >
                <span className="debug-frame-name">{frame.name}</span>
                <span className="debug-frame-location">
                  {frame.source?.name ?? (frame.source?.path ? basename(frame.source.path) : "")}
                  {frame.line > 0 ? `:${frame.line}` : ""}
                </span>
              </button>
            ))
          )}
        </section>

        <section className="debug-section">
          <div className="debug-section-title">{t("debug.breakpoints")}</div>
          {Object.values(debug.breakpoints).flat().length === 0 ? (
            <div className="debug-empty">{t("debug.noBreakpoints")}</div>
          ) : (
            Object.entries(debug.breakpoints).flatMap(([sourcePath, breakpoints]) =>
              breakpoints.map((breakpoint) => {
                const sessionData = debug.activeSessionId
                  ? breakpoint.sessionData?.[debug.activeSessionId]
                  : undefined;
                return (
                  <div
                    key={breakpoint.id}
                    className="debug-breakpoint"
                    title={sessionData?.message ?? sourcePath}
                  >
                    <span className={`debug-breakpoint-dot ${sessionData?.verified ? "verified" : ""}`} />
                    <button onClick={() => openFile(sourcePath)}>
                      {basename(sourcePath)}:{breakpoint.line}
                      {sessionData?.line != null &&
                      sessionData.line !== breakpoint.line
                        ? ` -> ${sessionData.line}`
                        : ""}
                    </button>
                    <button
                      className="icon-btn"
                      title={t("debug.removeBreakpoint")}
                      onClick={() => void toggleBreakpoint(sourcePath, breakpoint.line)}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                );
              }),
            )
          )}
        </section>
      </div>
    </div>
  );
}
