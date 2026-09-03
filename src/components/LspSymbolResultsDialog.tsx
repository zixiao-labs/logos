import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/language";
import type { LspSymbolResult } from "../lib/lsp-monaco";
import { openLspSymbolResult } from "../lib/lsp-monaco";
import { Icon } from "./Icon";
import { createMultiBufferDocument } from "../lib/multibuffer";
import { useStore } from "../state/store";
import { useT } from "../i18n";

interface ResultsDetail {
  title: string;
  items: LspSymbolResult[];
}

export function LspSymbolResultsDialog() {
  const t = useT();
  const openMultiBuffer = useStore((state) => state.openMultiBuffer);
  const [results, setResults] = useState<ResultsDetail | null>(null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResults = (event: Event) => {
      setResults((event as CustomEvent<ResultsDetail>).detail);
    };
    window.addEventListener("logos:lsp-symbol-results", onResults);
    return () => window.removeEventListener("logos:lsp-symbol-results", onResults);
  }, []);

  if (!results) return null;
  return (
    <div className="overlay" onMouseDown={() => setResults(null)}>
      <div
        className="palette lsp-results"
        ref={host}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="lsp-results-title">
          <span>{results.title}</span>
          <button
            className="btn ghost lsp-results-multibuffer"
            disabled={results.items.length === 0}
            onClick={() => {
              openMultiBuffer(
                createMultiBufferDocument(
                  `lsp:${results.title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                  results.title,
                  "reference",
                  results.items.map((item, index) => ({
                    id: `${item.path}:${item.range.startLineNumber}:${item.range.startColumn}:${index}`,
                    path: item.path,
                    startLine: item.range.startLineNumber,
                    startColumn: item.range.startColumn,
                    endLine: item.range.endLineNumber,
                    endColumn: item.range.endColumn,
                    label: item.detail ? `${item.name} · ${item.detail}` : item.name,
                  })),
                ),
              );
              setResults(null);
            }}
          >
            <Icon name="split" size={13} />
            {t("search.openInEditor")}
          </button>
        </div>
        <div className="palette-list">
          {results.items.map((item, index) => (
            <div
              className="palette-item"
              key={`${item.path}:${item.range.startLineNumber}:${item.name}:${index}`}
              onClick={() => {
                openLspSymbolResult(item);
                setResults(null);
              }}
            >
              <Icon name="search" size={15} />
              {item.name}
              <span className="hint">
                {item.detail ? `${item.detail} · ` : ""}
                {basename(item.path)}:{item.range.startLineNumber}
              </span>
              {item.loadChildren && (
                <button
                  className="lsp-results-expand"
                  title="Expand"
                  onClick={(event) => {
                    event.stopPropagation();
                    void item.loadChildren?.().then((items) =>
                      setResults({ title: `${results.title}: ${item.name}`, items }),
                    );
                  }}
                >
                  &gt;
                </button>
              )}
            </div>
          ))}
          {results.items.length === 0 && (
            <div className="lsp-results-empty">No results</div>
          )}
        </div>
      </div>
    </div>
  );
}
