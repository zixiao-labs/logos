import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename, dirname, languageFromPath } from "../lib/language";
import { canonicalPath } from "../lib/breadcrumbs";
import {
  buildGitDiffExcerpts,
  type GitDiffExcerpt,
} from "../lib/git-multidiff";
import { Icon } from "./Icon";

interface MultiGitDiffEditorProps {
  root: string;
}

function clearModels(editor: monaco.editor.IStandaloneDiffEditor) {
  const model = editor.getModel();
  if (!model) return;
  editor.setModel(null);
  model.original.dispose();
  if (model.modified !== model.original) model.modified.dispose();
}

function InlineDiffExcerpt({
  root,
  excerpt,
  reloadToken,
}: {
  root: string;
  excerpt: GitDiffExcerpt;
  reloadToken: object | null;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [height, setHeight] = useState(160);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      folding: false,
      lineNumbersMinChars: 3,
      padding: { top: 8, bottom: 8 },
    });
    editorRef.current = editor;

    const syncHeight = () => {
      const contentHeight = Math.max(
        editor.getOriginalEditor().getContentHeight(),
        editor.getModifiedEditor().getContentHeight(),
      );
      setHeight(Math.min(4_000, Math.max(96, Math.ceil(contentHeight))));
    };
    const originalSize = editor
      .getOriginalEditor()
      .onDidContentSizeChange(syncHeight);
    const modifiedSize = editor
      .getModifiedEditor()
      .onDidContentSizeChange(syncHeight);
    const diffUpdated = editor.onDidUpdateDiff(syncHeight);

    return () => {
      originalSize.dispose();
      modifiedSize.dispose();
      diffUpdated.dispose();
      if (editorRef.current === editor) editorRef.current = null;
      clearModels(editor);
      editor.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.logos.git
      .fileDiff(root, excerpt.path, excerpt.staged)
      .then((diff) => {
        if (cancelled || editorRef.current !== editor) return;
        clearModels(editor);
        const uriKey = encodeURIComponent(excerpt.key);
        const language = languageFromPath(excerpt.path);
        const original = monaco.editor.createModel(
          diff.original,
          language,
          monaco.Uri.parse(`git-multi-original:///${uriKey}`),
        );
        const modified = monaco.editor.createModel(
          diff.modified,
          language,
          monaco.Uri.parse(`git-multi-modified:///${uriKey}`),
        );
        editor.setModel({ original, modified });
        setLoading(false);
        requestAnimationFrame(() => {
          const contentHeight = Math.max(
            editor.getOriginalEditor().getContentHeight(),
            editor.getModifiedEditor().getContentHeight(),
          );
          setHeight(Math.min(4_000, Math.max(96, Math.ceil(contentHeight))));
        });
      })
      .catch((reason: unknown) => {
        if (cancelled || editorRef.current !== editor) return;
        clearModels(editor);
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [excerpt, reloadToken, retryVersion, root]);

  return (
    <div className="multi-diff-body" style={{ height }}>
      <div ref={hostRef} className="multi-diff-monaco" />
      {(loading || error) && (
        <div className="multi-diff-state">
          {loading ? (
            t("git.diffLoading")
          ) : (
            <>
              <span>{error || t("git.diffLoadFailed")}</span>
              <button
                type="button"
                className="btn multi-diff-retry"
                onClick={() => setRetryVersion((version) => version + 1)}
              >
                {t("common.retry")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function MultiGitDiffEditor({ root }: MultiGitDiffEditorProps) {
  const t = useT();
  const repository = useStore((state) => state.gitRepositories[root] ?? null);
  const openFile = useStore((state) => state.openFile);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const excerpts = useMemo(
    () => buildGitDiffExcerpts(repository?.status.changes ?? []),
    [repository],
  );

  const fileCount = new Set(excerpts.map((excerpt) => excerpt.path)).size;

  return (
    <div className="multi-diff-scroll" data-testid="multi-diff">
      <div className="multi-diff-toolbar">
        <span className="multi-diff-summary">
          <Icon name="git" size={14} />
          {t("git.uncommittedChanges")} · {fileCount}
        </span>
        <span className="multi-diff-toolbar-spacer" />
        <button
          type="button"
          className="icon-btn"
          title={t("git.expandAll")}
          onClick={() => setCollapsed(new Set())}
        >
          <Icon name="chevron-down" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t("git.collapseAll")}
          onClick={() =>
            setCollapsed(new Set(excerpts.map((excerpt) => excerpt.key)))
          }
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      {excerpts.length === 0 ? (
        <div className="welcome">{t("git.clean")}</div>
      ) : (
        excerpts.map((excerpt) => {
          const isCollapsed = collapsed.has(excerpt.key);
          const absolutePath = canonicalPath(`${root}/${excerpt.path}`);
          return (
            <section
              className="multi-diff-section"
              data-diff-excerpt={excerpt.key}
              key={excerpt.key}
            >
              <div className="multi-diff-section-header">
                <button
                  type="button"
                  className="multi-diff-collapse"
                  aria-label={isCollapsed ? t("git.expand") : t("git.collapse")}
                  aria-expanded={!isCollapsed}
                  onClick={() => {
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(excerpt.key)) next.delete(excerpt.key);
                      else next.add(excerpt.key);
                      return next;
                    });
                  }}
                >
                  <Icon
                    name={isCollapsed ? "chevron-right" : "chevron-down"}
                    size={14}
                  />
                </button>
                <button
                  type="button"
                  className="multi-diff-file"
                  title={`${t("git.openFile")}: ${absolutePath}`}
                  onClick={() => openFile(absolutePath)}
                >
                  <span className="multi-diff-file-name">
                    {basename(excerpt.path)}
                  </span>
                  <span className="multi-diff-file-path">{dirname(excerpt.path)}</span>
                </button>
                <span className="multi-diff-kind">
                  {excerpt.staged ? t("git.staged") : t("git.workingTree")}
                </span>
              </div>
              {!isCollapsed && (
                <InlineDiffExcerpt
                  root={root}
                  excerpt={excerpt}
                  reloadToken={repository}
                />
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
