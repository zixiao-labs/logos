import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { createMultiBufferDocument } from "../lib/multibuffer";
import { openLspSymbolResult } from "../lib/lsp-monaco";
import type { TextSearchMatch } from "../shared/types";
import { Icon } from "./Icon";

const MAX_RESULTS = 1000;

export function SearchPanel() {
  const t = useT();
  const root = useStore((state) => state.root);
  const workspaceFolders = useStore((state) => state.workspaceFolders);
  const openMultiBuffer = useStore((state) => state.openMultiBuffer);
  const [query, setQuery] = useState("");
  const [resultQuery, setResultQuery] = useState("");
  const [results, setResults] = useState<TextSearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const searchGeneration = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    const generation = ++searchGeneration.current;
    if (!trimmed || workspaceFolders.length === 0) {
      setResults([]);
      setResultQuery("");
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void Promise.all(
        workspaceFolders.map((folder) =>
          window.logos.fs
            .searchText(folder, trimmed, { maxResults: MAX_RESULTS })
            .catch(() => []),
        ),
      ).then((matches) => {
        if (searchGeneration.current !== generation) return;
        setResults(
          matches
            .flat()
            .sort(
              (a, b) =>
                a.path.localeCompare(b.path) ||
                a.line - b.line ||
                a.column - b.column,
            )
            .slice(0, MAX_RESULTS),
        );
        setResultQuery(trimmed);
        setLoading(false);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, workspaceFolders]);

  const resultFiles = useMemo(
    () => new Set(results.map((result) => result.path)).size,
    [results],
  );

  function openResult(result: TextSearchMatch) {
    openLspSymbolResult({
      name: result.text.trim(),
      path: result.path,
      range: {
        startLineNumber: result.line,
        startColumn: result.column,
        endLineNumber: result.line,
        endColumn: result.endColumn,
      },
    });
  }

  function openResultsInEditor() {
    const trimmed = query.trim();
    if (!results.length || trimmed !== resultQuery) return;
    openMultiBuffer(
      createMultiBufferDocument(
        `search:${trimmed}`,
        `${t("activity.search")}: ${trimmed}`,
        "search",
        results.map((result, index) => ({
          id: `${result.path}:${result.line}:${result.column}:${index}`,
          path: result.path,
          startLine: result.line,
          startColumn: result.column,
          endLine: result.line,
          endColumn: result.endColumn,
          label: result.text.trim(),
        })),
      ),
    );
  }

  if (!root) {
    return (
      <div className="sidepanel" style={{ width: "100%" }}>
        <div className="panel-header">{t("activity.search")}</div>
        <div className="empty-state">{t("explorer.noFolder")}</div>
      </div>
    );
  }

  return (
    <div className="sidepanel" style={{ width: "100%" }}>
      <div className="panel-header">{t("activity.search")}</div>
      <div className="search-box multibuffer-search-box">
        <input
          autoFocus
          className="field"
          aria-label={t("search.placeholder")}
          placeholder={t("search.filesOnly")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") openResultsInEditor();
          }}
        />
        <button
          className="icon-btn"
          data-testid="open-search-multibuffer"
          title={t("search.openInEditor")}
          disabled={loading || !results.length || query.trim() !== resultQuery}
          onClick={openResultsInEditor}
        >
          <Icon name="split" size={14} />
        </button>
      </div>
      <div className="search-meta">
        {loading
          ? t("search.searching")
          : resultQuery
            ? `${results.length} ${t("multibuffer.matches")} · ${resultFiles} ${t("search.files")}`
            : t("search.hint")}
      </div>
      <div className="scroll-y">
        {resultQuery && !loading && results.length === 0 && (
          <div className="empty-state">{t("search.noResults")}</div>
        )}
        {results.slice(0, 300).map((result, index) => (
          <button
            type="button"
            key={`${result.path}:${result.line}:${result.column}:${index}`}
            className="search-result search-text-result"
            onClick={() => openResult(result)}
          >
            <span className="search-result-preview">{result.text.trim()}</span>
            <span className="path">
              {basename(result.path)}:{result.line}:{result.column}
            </span>
          </button>
        ))}
        {results.length > 300 && (
          <div className="search-meta search-overflow">
            {t("search.moreInEditor")}
          </div>
        )}
      </div>
    </div>
  );
}
