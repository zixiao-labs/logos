import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useStore } from "../state/store";

export function DebugConsole() {
  const t = useT();
  const entries = useStore((state) => state.debug.console);
  const sessionId = useStore((state) => state.debug.activeSessionId);
  const sessionStatus = useStore((state) =>
    state.debug.activeSessionId
      ? state.debug.sessions[state.debug.activeSessionId]?.status
      : undefined,
  );
  const evaluate = useStore((state) => state.evaluateDebug);
  const openFile = useStore((state) => state.openFile);
  const [expression, setExpression] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [entries]);

  const submit = () => {
    const value = expression.trim();
    if (!value) return;
    setExpression("");
    void evaluate(value);
  };

  return (
    <div className="debug-console">
      <div ref={outputRef} className="debug-console-output">
        {entries.length === 0 ? (
          <div className="output-empty">{t("debug.consoleEmpty")}</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={`debug-console-entry ${entry.category}`}
              onClick={() => {
                if (entry.source?.path) openFile(entry.source.path);
              }}
              title={entry.source?.path}
            >
              {entry.output}
            </div>
          ))
        )}
      </div>
      <div className="debug-console-input">
        <span>&gt;</span>
        <input
          value={expression}
          disabled={
            !sessionId ||
            sessionStatus === "terminated" ||
            sessionStatus === "error" ||
            sessionStatus === "terminating"
          }
          placeholder={t("debug.consolePlaceholder")}
          onChange={(event) => setExpression(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </div>
  );
}
