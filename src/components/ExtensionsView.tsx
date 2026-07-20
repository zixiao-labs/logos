import { useCallback, useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import type { LanguageServerInfo, LanguageServerStatus } from "../shared/types";
import { activateLspServer } from "../lib/lsp-monaco";
import type {
  ExtensionCompatibility,
  ExtensionRegistrySnapshot,
} from "../shared/extensions";

const BADGE: Record<LanguageServerStatus, { cls: string; key: string }> = {
  "not-installed": { cls: "none", key: "lsp.notInstalled" },
  installing: { cls: "none", key: "lsp.install" },
  installed: { cls: "installed", key: "lsp.installed" },
  starting: { cls: "running", key: "lsp.running" },
  running: { cls: "running", key: "lsp.running" },
  stopped: { cls: "installed", key: "lsp.installed" },
  error: { cls: "error", key: "lsp.error" },
};

const EXTENSION_BADGE: Record<ExtensionCompatibility, { cls: string; key: string }> = {
  "safe-compatible": { cls: "installed", key: "extensions.safeCompatible" },
  "requires-authorization": { cls: "none", key: "extensions.needsPermission" },
  "api-unsupported": { cls: "error", key: "extensions.apiUnsupported" },
  blocked: { cls: "error", key: "extensions.blocked" },
};

const EMPTY_REGISTRY: ExtensionRegistrySnapshot = {
  status: "missing",
  source: "local-development",
  extensions: [],
};

export function ExtensionsView() {
  const t = useT();
  const root = useStore((s) => s.root);
  const autoDownloadLsp = useStore((s) => s.settings["lsp.autoDownload"]);
  // C1: live status comes from the shared store slice (single source of truth);
  // the static catalogue (labels, versions, descriptions) comes from list().
  const lsp = useStore((s) => s.lsp);
  const [servers, setServers] = useState<LanguageServerInfo[]>([]);
  const [registry, setRegistry] = useState<ExtensionRegistrySnapshot>(EMPTY_REGISTRY);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryBusyId, setRegistryBusyId] = useState<string>();
  const [registryError, setRegistryError] = useState<string>();

  const refresh = useCallback(async () => {
    setServers(await window.logos.lsp.list().catch(() => []));
  }, []);

  async function refreshRegistry() {
    setRegistryLoading(true);
    setRegistryError(undefined);
    try {
      setRegistry(await window.logos.extensions.list());
    } catch (error) {
      setRegistryError(error instanceof Error ? error.message : t("extensions.loadFailed"));
    } finally {
      setRegistryLoading(false);
    }
  }

  async function changeExtension(id: string, action: "install" | "uninstall") {
    setRegistryBusyId(id);
    setRegistryError(undefined);
    try {
      setRegistry(await window.logos.extensions[action](id));
    } catch (error) {
      setRegistryError(error instanceof Error ? error.message : t("extensions.changeFailed"));
    } finally {
      setRegistryBusyId(undefined);
    }
  }

  // Re-list on mount and whenever a server's status changes (e.g. an install
  // finished) so installed versions stay current.
  const statusSig = Object.values(lsp)
    .map((p) => `${p.id}:${p.status}`)
    .sort()
    .join(",");
  useEffect(() => {
    void refresh();
  }, [refresh, statusSig]);
  useEffect(() => {
    void refreshRegistry();
  }, []);

  return (
    <div className="simple-view">
      <div className="settings-head">
        <h2 style={{ margin: 0 }}>{t("extensions.title")}</h2>
        <button
          className="btn ghost"
          style={{ width: "auto" }}
          disabled={registryLoading}
          onClick={() => void refreshRegistry()}
        >
          {registryLoading ? "…" : t("explorer.refresh")}
        </button>
      </div>
      <p className="extension-section-note">{t("extensions.developmentRegistry")}</p>
      {(registryError || registry.message) && (
        <div className={`extension-registry-message ${registry.status === "invalid" ? "error" : ""}`}>
          {registryError ?? registry.message}
        </div>
      )}
      {!registryLoading && registry.status === "ready" && registry.extensions.length === 0 && (
        <div className="extension-registry-message">{t("extensions.empty")}</div>
      )}
      {registry.extensions.map(extension => {
        const badge = EXTENSION_BADGE[extension.compatibility];
        const busy = registryBusyId === extension.id;
        return (
          <div key={extension.id} className="extension-item">
            <div className="info">
              <div className="name">
                {extension.displayName}{" "}
                <span className="extension-version">v{extension.version}</span>
              </div>
              <div className="desc">{extension.description}</div>
              <div className="desc extension-identity">
                {extension.id} · {extension.runtime}
              </div>
              {extension.permissions.length > 0 && (
                <div className="desc extension-permissions">
                  {t("extensions.requests")}: {extension.permissions.map(item => item.id).join(", ")}
                </div>
              )}
            </div>
            <span className={`badge ${extension.installed ? "running" : badge.cls}`}>
              {extension.installed ? t("extensions.installed") : t(badge.key)}
            </span>
            <div className="extension-actions">
              {extension.installed ? (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => void changeExtension(extension.id, "uninstall")}
                >
                  {busy ? "…" : t("extensions.uninstall")}
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busy || !extension.installable}
                  title={extension.installable ? "" : t(badge.key)}
                  onClick={() => void changeExtension(extension.id, "install")}
                >
                  {busy ? "…" : t("extensions.install")}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div className="settings-head extension-lsp-head">
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
        Managed language servers start on demand and connect LSP features to the
        editor; {autoDownloadLsp
          ? "with Auto-download on, missing servers download only when matching files are opened."
          : "Auto-download is off, so install missing servers here before use."}
      </p>

      {servers.map((s) => {
        const status = lsp[s.id]?.status ?? s.status;
        const message = lsp[s.id]?.message;
        const badge = BADGE[status];
        const installed = status !== "not-installed" && status !== "installing";
        const running = status === "running" || status === "starting";
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
              {message && (
                <div
                  className="desc"
                  style={{
                    color: status === "error" ? "var(--danger)" : "var(--muted)",
                    marginTop: 2,
                  }}
                >
                  {message}
                </div>
              )}
            </div>
            <span className={`badge ${badge.cls}`}>{t(badge.key)}</span>
            <div className="lsp-actions">
              {!installed ? (
                <button
                  className="btn"
                  disabled={status === "installing"}
                  onClick={() => void window.logos.lsp.install(s.id).catch(() => {})}
                >
                  {status === "installing" ? "…" : t("lsp.install")}
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
                      root &&
                       void activateLspServer(s.id, root)
                        .then(refresh)
                        .catch(() => {})
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
