import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useStore } from "../state/store";

interface GitDiffEditorProps {
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

export function GitDiffEditor({ path, staged, language }: GitDiffEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const root = useStore((state) => state.root);
  const git = useStore((state) => state.git);

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
    return () => {
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
        setError(message || "Failed to load diff.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [git, language, path, reloadVersion, root, staged]);

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
            <span>Loading diff...</span>
          ) : (
            <>
              <span>{error}</span>
              <button
                type="button"
                className="btn"
                style={{ width: "auto" }}
                onClick={() => setReloadVersion((version) => version + 1)}
              >
                Retry
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
