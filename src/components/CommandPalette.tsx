import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename } from "../lib/language";
import { listWorkspaceFiles } from "../lib/workspaceFiles";
import {
  lspWorkspaceSymbols,
  openLspWorkspaceSymbol,
  type LspWorkspaceSymbolResult,
} from "../lib/lsp-monaco";
import { Icon, type IconName } from "./Icon";

interface Command {
  id: string;
  title: string;
  icon: IconName;
  run: () => void;
}

export function CommandPalette() {
  const t = useT();
  const open = useStore((s) => s.paletteOpen);
  const close = useStore((s) => s.closePalette);
  const store = useStore;
  const root = useStore((s) => s.root);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [symbols, setSymbols] = useState<LspWorkspaceSymbolResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      if (root) void listWorkspaceFiles(root).then(setFiles);
    }
  }, [open, root]);

  const commands: Command[] = useMemo(() => {
    const s = store.getState();
    return [
      { id: "openFolder", title: t("cmd.openFolder"), icon: "folder", run: () => void s.openFolder() },
      { id: "save", title: t("cmd.save"), icon: "check", run: () => window.dispatchEvent(new CustomEvent("logos:save")) },
      { id: "toggleLayout", title: t("cmd.toggleLayout"), icon: "layout", run: () => s.toggleLayout() },
      { id: "toggleTheme", title: t("cmd.toggleTheme"), icon: "sun", run: () => s.toggleTheme() },
      { id: "toggleLanguage", title: t("cmd.toggleLanguage"), icon: "translate", run: () => s.toggleLanguage() },
      { id: "newTerminal", title: t("cmd.newTerminal"), icon: "terminal", run: () => void s.newTerminal() },
      { id: "openSettings", title: t("cmd.openSettings"), icon: "settings", run: () => s.openSpecial("settings") },
      { id: "extensions", title: t("activity.extensions"), icon: "extensions", run: () => s.openSpecial("extensions") },
      {
        id: "newAgent",
        title: t("cmd.newAgent"),
        icon: "agent",
        run: () => {
          s.newAgentSession();
          s.setSidebarView("agent");
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const isCommandMode = query.startsWith(">");
  const isSymbolMode = query.startsWith("#");

  useEffect(() => {
    if (!open || !isSymbolMode) {
      setSymbols([]);
      return;
    }
    const symbolQuery = query.slice(1).trim();
    if (!symbolQuery) {
      setSymbols([]);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void lspWorkspaceSymbols(
        symbolQuery,
        controller.signal,
        (partial) => {
          if (!cancelled) setSymbols(partial.slice(0, 100));
        },
      )
        .then((result) => {
          if (!cancelled) setSymbols(result.slice(0, 100));
        })
        .catch(() => {
          if (!cancelled) setSymbols([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, isSymbolMode, query]);

  const filteredCommands = useMemo(() => {
    const q = query.replace(/^>/, "").trim().toLowerCase();
    return commands.filter((c) => c.title.toLowerCase().includes(q));
  }, [commands, query]);

  const filteredFiles = useMemo(() => {
    if (isCommandMode || isSymbolMode) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 50);
  }, [files, query, isCommandMode, isSymbolMode]);

  const total = isSymbolMode
    ? symbols.length
    : isCommandMode
    ? filteredCommands.length
    : filteredFiles.length + (query.trim() ? 0 : filteredCommands.length);

  if (!open) return null;

  const showCommands = isCommandMode || (!isSymbolMode && !query.trim());

  function execute(i: number) {
    if (isSymbolMode) {
      const symbol = symbols[i];
      if (symbol) openLspWorkspaceSymbol(symbol);
    } else if (isCommandMode) {
      filteredCommands[i]?.run();
    } else if (query.trim()) {
      const f = filteredFiles[i];
      if (f) store.getState().openFile(f);
    } else {
      filteredCommands[i]?.run();
    }
    close();
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={t("cmd.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, Math.max(total - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              execute(index);
            } else if (e.key === "Escape") {
              close();
            }
          }}
        />
        <div className="palette-list">
          {showCommands &&
            filteredCommands.map((c, i) => (
              <div
                key={c.id}
                className={`palette-item ${i === index ? "active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => execute(i)}
              >
                <Icon name={c.icon} size={15} />
                {c.title}
              </div>
            ))}
          {!isCommandMode &&
            !isSymbolMode &&
            filteredFiles.map((f, i) => (
              <div
                key={f}
                className={`palette-item ${i === index ? "active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => execute(i)}
              >
                <Icon name="file" size={15} />
                {basename(f)}
                <span className="hint">
                  {root && f.startsWith(root) ? f.slice(root.length + 1) : f}
                </span>
              </div>
            ))}
          {isSymbolMode &&
            symbols.map((symbol, i) => (
              <div
                key={`${symbol.path}:${symbol.range.startLineNumber}:${symbol.name}`}
                className={`palette-item ${i === index ? "active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => execute(i)}
              >
                <Icon name="search" size={15} />
                {symbol.name}
                <span className="hint">
                  {symbol.containerName ? `${symbol.containerName} · ` : ""}
                  {basename(symbol.path)}:{symbol.range.startLineNumber}
                </span>
              </div>
            ))}
          {total === 0 && (
            <div style={{ padding: 16, color: "var(--muted)" }}>
              {t("search.noResults")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
