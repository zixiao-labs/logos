import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useT } from "../i18n";
import { languageFromPath } from "../lib/language";
import type {
  MultiBufferDocument,
  MultiBufferExcerpt,
  MultiBufferMatch,
} from "../lib/multibuffer";
import { openLspSymbolResult } from "../lib/lsp-monaco";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { defineEditorThemes, sharedEditorOptions } from "./MonacoEditor";

interface ExcerptCodeProps {
  documentId: string;
  excerpt: MultiBufferExcerpt;
  content: string;
  onOpen(match?: MultiBufferMatch): void;
}

function sourceRange(
  excerpt: MultiBufferExcerpt,
  match?: MultiBufferMatch,
): monaco.IRange {
  const target = match ?? excerpt.matches[0];
  return {
    startLineNumber: target?.startLine ?? excerpt.startLine,
    startColumn: target?.startColumn ?? 1,
    endLineNumber: target?.endLine ?? excerpt.startLine,
    endColumn: target?.endColumn ?? 1,
  };
}

function ExcerptCode({ documentId, excerpt, content, onOpen }: ExcerptCodeProps) {
  const host = useRef<HTMLDivElement>(null);
  const onOpenRef = useRef(onOpen);
  const settings = useStore((state) => state.settings);
  const lines = useMemo(() => content.split(/\r?\n/), [content]);
  const startLine = Math.min(Math.max(1, excerpt.startLine), Math.max(lines.length, 1));
  const endLine = Math.min(Math.max(startLine, excerpt.endLine), Math.max(lines.length, 1));
  const snippet = lines.slice(startLine - 1, endLine).join("\n");
  const lineHeight = Math.max(18, Math.round(settings["editor.fontSize"] * 1.55));
  const height = Math.min(520, Math.max(54, (endLine - startLine + 1) * lineHeight + 16));

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    if (!host.current) return;
    defineEditorThemes();
    const uri = monaco.Uri.parse(
      `inmemory://logos-multibuffer/${encodeURIComponent(documentId)}/${encodeURIComponent(excerpt.id)}`,
    );
    const model = monaco.editor.createModel(
      snippet,
      languageFromPath(excerpt.path),
      uri,
    );
    const editor = monaco.editor.create(host.current, {
      ...sharedEditorOptions(useStore.getState().settings),
      model,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      theme:
        useStore.getState().settings["workbench.theme"] === "dark"
          ? "logos-dark"
          : "logos-light",
      lineNumbers: (line) => String(startLine + line - 1),
      lineNumbersMinChars: String(endLine).length,
      glyphMargin: false,
      folding: false,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      renderLineHighlight: "none",
      scrollBeyondLastLine: false,
      scrollbar: {
        vertical: height >= 520 ? "auto" : "hidden",
        horizontal: "auto",
        alwaysConsumeMouseWheel: false,
      },
      padding: { top: 8, bottom: 8 },
      fixedOverflowWidgets: true,
    });
    const decorations = editor.createDecorationsCollection(
      excerpt.matches.map((match) => {
        const range = model.validateRange(
          new monaco.Range(
            match.startLine - startLine + 1,
            match.startColumn,
            match.endLine - startLine + 1,
            match.endColumn,
          ),
        );
        return {
          range,
          options: {
            className:
              match.severity === 1
                ? "multibuffer-match-error"
                : match.severity === 2
                  ? "multibuffer-match-warning"
                  : "multibuffer-match",
            inlineClassName: "multibuffer-match-inline",
          },
        };
      }),
    );
    const mouse = editor.onMouseDown((event) => {
      if (event.event.detail < 2 || !event.target.position) return;
      const sourceLine = startLine + event.target.position.lineNumber - 1;
      const match = excerpt.matches.find(
        (candidate) =>
          candidate.startLine <= sourceLine && candidate.endLine >= sourceLine,
      );
      onOpenRef.current(match);
    });
    return () => {
      mouse.dispose();
      decorations.clear();
      editor.dispose();
      model.dispose();
    };
  }, [documentId, endLine, excerpt, height, snippet, startLine]);

  return <div className="multibuffer-monaco" ref={host} style={{ height }} />;
}

interface LazyExcerptCodeProps extends ExcerptCodeProps {
  collapsed: boolean;
}

function LazyExcerptCode(props: LazyExcerptCodeProps) {
  const placeholder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (visible || props.collapsed || !placeholder.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, [props.collapsed, visible]);

  if (props.collapsed) return null;
  if (!visible) {
    return <div className="multibuffer-placeholder" ref={placeholder} />;
  }
  return <ExcerptCode {...props} />;
}

export function MultiBufferEditor({ document }: { document: MultiBufferDocument }) {
  const t = useT();
  const workspaceFolders = useStore((state) => state.workspaceFolders);
  const [contents, setContents] = useState<Record<string, string | null>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeExcerptId, setActiveExcerptId] = useState<string | null>(
    document.excerpts[0]?.id ?? null,
  );
  const scrollHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setContents({});
    setCollapsed(new Set());
    setActiveExcerptId(document.excerpts[0]?.id ?? null);
    const paths = [...new Set(document.excerpts.map((excerpt) => excerpt.path))];
    void Promise.all(
      paths.map(async (path) => {
        const content = await window.logos.fs.readFile(path).catch(() => null);
        if (cancelled) return;
        setContents((current) => ({ ...current, [path]: content }));
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [document]);

  const matchCount = document.excerpts.reduce(
    (total, excerpt) => total + excerpt.matches.length,
    0,
  );
  const activeIndex = Math.max(
    0,
    document.excerpts.findIndex((excerpt) => excerpt.id === activeExcerptId),
  );

  function displayPath(path: string): string {
    const root = workspaceFolders.find(
      (folder) => path === folder || path.startsWith(`${folder}/`),
    );
    return root && path !== root ? path.slice(root.length + 1) : path;
  }

  function openExcerpt(excerpt: MultiBufferExcerpt, match?: MultiBufferMatch) {
    const target = match ?? excerpt.matches[0];
    openLspSymbolResult({
      name: target?.label ?? document.title,
      path: excerpt.path,
      range: sourceRange(excerpt, target),
    });
  }

  function moveActive(delta: number) {
    if (!document.excerpts.length) return;
    const next = Math.min(
      document.excerpts.length - 1,
      Math.max(0, activeIndex + delta),
    );
    const excerpt = document.excerpts[next];
    if (!excerpt) return;
    setActiveExcerptId(excerpt.id);
    scrollHost.current
      ?.querySelector<HTMLElement>(`[data-excerpt-index="${next}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  return (
    <div className="multibuffer-surface" data-multibuffer={document.id}>
      <div className="multibuffer-toolbar">
        <div className="multibuffer-summary">
          <strong>{document.title}</strong>
          <span>
            {matchCount} {t("multibuffer.matches")} · {document.excerpts.length}{" "}
            {t("multibuffer.excerpts")}
          </span>
        </div>
        <div className="multibuffer-toolbar-spacer" />
        <button
          className="icon-btn multibuffer-previous"
          title={t("multibuffer.previous")}
          disabled={activeIndex <= 0}
          onClick={() => moveActive(-1)}
        >
          <Icon name="chevron-right" />
        </button>
        <button
          className="icon-btn"
          title={t("multibuffer.next")}
          disabled={activeIndex >= document.excerpts.length - 1}
          onClick={() => moveActive(1)}
        >
          <Icon name="chevron-right" />
        </button>
        <button
          className="btn ghost multibuffer-toolbar-button"
          disabled={!document.excerpts.length}
          onClick={() => {
            const excerpt = document.excerpts[activeIndex];
            if (excerpt) openExcerpt(excerpt);
          }}
        >
          {t("multibuffer.openSource")}
        </button>
        <button
          className="btn ghost multibuffer-toolbar-button"
          onClick={() =>
            setCollapsed(
              collapsed.size === document.excerpts.length
                ? new Set()
                : new Set(document.excerpts.map((excerpt) => excerpt.id)),
            )
          }
        >
          {collapsed.size === document.excerpts.length
            ? t("multibuffer.expandAll")
            : t("multibuffer.collapseAll")}
        </button>
      </div>

      <div className="multibuffer-scroll" ref={scrollHost}>
        {document.excerpts.length === 0 && (
          <div className="empty-state">{t("multibuffer.empty")}</div>
        )}
        {document.excerpts.map((excerpt, index) => {
          const isCollapsed = collapsed.has(excerpt.id);
          const content = contents[excerpt.path];
          const firstMatch = excerpt.matches[0];
          return (
            <section
              className={`multibuffer-excerpt ${
                activeExcerptId === excerpt.id ? "active" : ""
              }`}
              data-excerpt-index={index}
              data-multibuffer-excerpt={excerpt.id}
              key={excerpt.id}
              onMouseDown={() => setActiveExcerptId(excerpt.id)}
            >
              <div className="multibuffer-divider">
                <button
                  className="multibuffer-collapse"
                  title={
                    isCollapsed
                      ? t("multibuffer.expandExcerpt")
                      : t("multibuffer.collapseExcerpt")
                  }
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(excerpt.id)) next.delete(excerpt.id);
                      else next.add(excerpt.id);
                      return next;
                    })
                  }
                >
                  <Icon
                    name="chevron-down"
                    size={13}
                    className={isCollapsed ? "collapsed" : undefined}
                  />
                </button>
                <button
                  className="multibuffer-source"
                  title={`${t("multibuffer.openSource")}: ${excerpt.path}`}
                  onClick={() => openExcerpt(excerpt)}
                >
                  <span>{displayPath(excerpt.path)}</span>
                  <span className="multibuffer-location">
                    :{firstMatch?.startLine ?? excerpt.startLine}
                  </span>
                </button>
                <span className={`multibuffer-kind ${excerpt.kind}`}>
                  {t(`multibuffer.kind.${excerpt.kind}`)}
                </span>
                {firstMatch?.label && (
                  <span className="multibuffer-message" title={firstMatch.label}>
                    {firstMatch.label}
                  </span>
                )}
              </div>
              {content === undefined ? (
                !isCollapsed && (
                  <div className="multibuffer-state">{t("multibuffer.loading")}</div>
                )
              ) : content === null ? (
                !isCollapsed && (
                  <div className="multibuffer-state">{t("multibuffer.unavailable")}</div>
                )
              ) : (
                <LazyExcerptCode
                  documentId={document.id}
                  excerpt={excerpt}
                  content={content}
                  collapsed={isCollapsed}
                  onOpen={(match) => openExcerpt(excerpt, match)}
                />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
