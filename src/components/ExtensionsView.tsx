import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import type { LanguageServerInfo, LanguageServerStatus } from "../shared/types";

const BADGE: Record<LanguageServerStatus, { cls: string; key: string }> = {
  "not-installed": { cls: "none", key: "lsp.notInstalled" },
  installing: { cls: "none", key: "lsp.install" },
  installed: { cls: "installed", key: "lsp.installed" },
  starting: { cls: "running", key: "lsp.running" },
  running: { cls: "running", key: "lsp.running" },
  stopped: { cls: "installed", key: "lsp.installed" },
  error: { cls: "error", key: "lsp.notInstalled" },
};

export function ExtensionsView() {
  const t = useT();
  const root = useStore((s) => s.root);
  const [servers, setServers] = useState<LanguageServerInfo[]>([]);
  const [messages, setMessages] = useState<Record<string, string>>({});

  async function refresh() {
    setServers(await window.logos.lsp.list());
  }

  useEffect(() => {
    void refresh();
    return window.logos.lsp.onProgress((p) => {
      setServers((prev) =>
        prev.map((s) => (s.id === p.id ? { ...s, status: p.status } : s)),
      );
      if (p.message)
        setMessages((m) => ({ ...m, [p.id]: p.message as string }));
      if (p.status === "installed" || p.status === "not-installed")
        void refresh();
    });
  }, []);

  return (
    <div className="simple-view">
      <div className="settings-head">
        <h2 style={{ margin: 0 }}>{t("lsp.title")}</h2>
        <button
          className="btn ghost"
          style={{ width: "auto" }}
          onClick={() => void refresh()}
        >
          {t("explorer.refresh")}
        </button>
      </div>
      <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 0 }}>
        Stage 2 · Sprint 1 — install language servers from npm into a managed
        directory; Logos starts them on demand and bridges LSP features into the
        editor.
      </p>

      {servers.map((s) => {
        const badge = BADGE[s.status];
        const installed = s.status !== "not-installed" && s.status !== "installing";
        const running = s.status === "running" || s.status === "starting";
        return (
          <div key={s.id} className="lsp-item">
            <div className="info">
              <div className="name">
                {s.label}{" "}
                {s.installedVersion && (
                  <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                    v{s.installedVersion}
                  </span>
                )}
              </div>
              <div className="desc">{s.description}</div>
              <div className="desc" style={{ fontFamily: "var(--mono-font)" }}>
                {s.languages.join(", ")}
              </div>
              {messages[s.id] && (
                <div
                  className="desc"
                  style={{ color: "var(--muted)", marginTop: 2 }}
                >
                  {messages[s.id]}
                </div>
              )}
            </div>
            <span className={`badge ${badge.cls}`}>{t(badge.key)}</span>
            <div className="lsp-actions">
              {!installed ? (
                <button
                  className="btn"
                  disabled={s.status === "installing"}
                  onClick={() => void window.logos.lsp.install(s.id)}
                >
                  {s.status === "installing" ? "…" : t("lsp.install")}
                </button>
              ) : running ? (
                <button
                  className="btn secondary"
                  onClick={() => void window.logos.lsp.stop(s.id).then(refresh)}
                >
                  {t("lsp.stop")}
                </button>
              ) : (
                <>
                  <button
                    className="btn"
                    disabled={!root}
                    title={root ? "" : t("explorer.noFolder")}
                    onClick={() =>
                      root && void window.logos.lsp.start(s.id, root).then(refresh)
                    }
                  >
                    {t("lsp.start")}
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() =>
                      void window.logos.lsp.uninstall(s.id).then(refresh)
                    }
                  >
                    {t("lsp.uninstall")}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
