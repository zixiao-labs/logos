import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { basename, dirname } from "../lib/language";
import { listWorkspaceFiles } from "../lib/workspaceFiles";

export function SearchPanel() {
  const t = useT();
  const root = useStore((s) => s.root);
  const openFile = useStore((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!root) {
      setFiles([]);
      return;
    }
    void listWorkspaceFiles(root).then(setFiles);
  }, [root]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 200);
  }, [query, files]);

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
      <div className="search-box">
        <input
          autoFocus
          className="field"
          placeholder={t("search.filesOnly")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="scroll-y">
        {query && results.length === 0 && (
          <div className="empty-state">{t("search.noResults")}</div>
        )}
        {results.map((f) => (
          <div key={f} className="search-result" onClick={() => openFile(f)}>
            <div>{basename(f)}</div>
            <div className="path">
              {root && f.startsWith(root) ? f.slice(root.length + 1) : dirname(f)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
