import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/language";
import type { LspSymbolResult } from "../lib/lsp-monaco";
import { openLspSymbolResult } from "../lib/lsp-monaco";
import { Icon } from "./Icon";

interface ResultsDetail {
  title: string;
  items: LspSymbolResult[];
}

export function LspSymbolResultsDialog() {
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
        <div className="lsp-results-title">{results.title}</div>
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
