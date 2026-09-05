import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { bindEditorKeymap } from "../lib/editor-keymap";

interface GitDiffEditorProps {
  root: string;
  path: string;
  staged: boolean;
  language: string;
}

function clearDiffModels(editor: monaco.editor.IStandaloneDiffEditor) {
  const model = editor.getModel();
  if (!model) return;
  editor.setModel(null);
  model.original.dispose();
  if (model.modified !== model.original) model.modified.dispose();
}

export function GitDiffEditor({ root, path, staged, language }: GitDiffEditorProps) {
  const t = useT();
  const diffLoadFailed = t("git.diffLoadFailed");
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const repository = useStore((state) => state.gitRepositories[root]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    editorRef.current = editor;
    const originalKeymap = bindEditorKeymap(editor.getOriginalEditor());
    const modifiedKeymap = bindEditorKeymap(editor.getModifiedEditor());
    return () => {
      originalKeymap.dispose();
      modifiedKeymap.dispose();
      if (editorRef.current === editor) editorRef.current = null;
      clearDiffModels(editor);
      editor.dispose();
    };
  }, []);

  useEffect(() => {
    if (!root || !editorRef.current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.logos.git
      .fileDiff(root, path, staged)
      .then((diff) => {
        if (cancelled || !editorRef.current) return;
        clearDiffModels(editorRef.current);
        const key = encodeURIComponent(`${staged ? "index" : "worktree"}:${path}`);
        const original = monaco.editor.createModel(
          diff.original,
          language,
          monaco.Uri.parse(`git-original:///${key}`),
        );
        const modified = monaco.editor.createModel(
          diff.modified,
          language,
          monaco.Uri.parse(`git-modified:///${key}`),
        );
        editorRef.current.setModel({ original, modified });
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled || !editorRef.current) return;
        clearDiffModels(editorRef.current);
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message || diffLoadFailed);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [diffLoadFailed, language, path, reloadVersion, repository, root, staged]);

  return (
    <>
      <div className="monaco-container git-diff-editor" ref={hostRef} />
      {(loading || error) && (
        <div
          className="welcome"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            background: "var(--background)",
          }}
        >
          {loading ? (
            <span>{t("git.diffLoading")}</span>
          ) : (
            <>
              <span>{error}</span>
              <button
                type="button"
                className="btn"
                style={{ width: "auto" }}
                onClick={() => setReloadVersion((version) => version + 1)}
              >
                {t("common.retry")}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
