import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "../i18n";
import type { DebugConsoleEntry } from "../shared/dap";
import { useStore } from "../state/store";

const ROW_HEIGHT = 18;
const OVERSCAN_ROWS = 12;
const VERTICAL_PADDING = 5;

type DebugConsoleRow = {
  id: string;
  category: DebugConsoleEntry["category"];
  output: string;
  sourcePath?: string;
};

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
  const rows = useMemo<DebugConsoleRow[]>(
    () =>
      entries.flatMap((entry) => {
        const lines = entry.output.split(/\r\n|\r|\n/);
        if (lines.length > 1 && lines.at(-1) === "") lines.pop();
        return lines.map((output, index) => ({
          id: `${entry.id}:${index}`,
          category: entry.category,
          output,
          sourcePath: entry.source?.path,
        }));
      }),
    [entries],
  );
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  const syncViewport = useCallback(() => {
    const output = outputRef.current;
    if (!output) return;
    const next = { scrollTop: output.scrollTop, height: output.clientHeight };
    setViewport((current) =>
      current.scrollTop === next.scrollTop && current.height === next.height
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    syncViewport();
    const output = outputRef.current;
    if (!output || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncViewport);
    observer.observe(output);
    return () => observer.disconnect();
  }, [syncViewport]);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output) return;
    output.scrollTop = output.scrollHeight;
    syncViewport();
  }, [entries, syncViewport]);

  const contentScrollTop = Math.max(viewport.scrollTop - VERTICAL_PADDING, 0);
  const startIndex = Math.max(
    0,
    Math.floor(contentScrollTop / ROW_HEIGHT) - OVERSCAN_ROWS,
  );
  const endIndex = Math.min(
    rows.length,
    Math.ceil((contentScrollTop + viewport.height) / ROW_HEIGHT) + OVERSCAN_ROWS,
  );
  const visibleRows = rows.slice(startIndex, endIndex);

  const submit = () => {
    const value = expression.trim();
    if (!value) return;
    setExpression("");
    void evaluate(value);
  };

  return (
    <div className="debug-console">
      <div
        ref={outputRef}
        className="debug-console-output"
        onScroll={syncViewport}
      >
        {entries.length === 0 ? (
          <div className="output-empty">{t("debug.consoleEmpty")}</div>
        ) : (
          <div
            className="debug-console-output-spacer"
            style={{ height: rows.length * ROW_HEIGHT + VERTICAL_PADDING * 2 }}
          >
            <div
              className="debug-console-output-window"
              style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}
            >
              {visibleRows.map((row) => (
                <div
                  key={row.id}
                  className={`debug-console-entry ${row.category}`}
                  onClick={() => {
                    if (row.sourcePath) openFile(row.sourcePath);
                  }}
                  title={row.sourcePath}
                >
                  {row.output}
                </div>
              ))}
            </div>
          </div>
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
