import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useStore } from "../state/store";

interface GitDiffEditorProps {
  path: string;
  staged: boolean;
  language: string;
}

export function GitDiffEditor({ path, staged, language }: GitDiffEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
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
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!root || !editorRef.current) return;
    let cancelled = false;
    void window.logos.git.fileDiff(root, path, staged).then((diff) => {
      if (cancelled || !editorRef.current) return;
      const previous = editorRef.current.getModel();
      editorRef.current.setModel(null);
      previous?.original.dispose();
      previous?.modified.dispose();
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
    });
    return () => {
      cancelled = true;
    };
  }, [git, language, path, root, staged]);

  return <div className="monaco-container git-diff-editor" ref={hostRef} />;
}
