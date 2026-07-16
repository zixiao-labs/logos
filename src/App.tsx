import { useEffect } from "react";
import { Toast } from "@heroui/react";
import { useStore } from "./state/store";
import { notifyInfo } from "./lib/toast";
import type { MenuAction } from "./shared/types";
import { setupLspMonaco } from "./lib/lsp-monaco";
import { closeTabSafely, setupMonacoFileSync } from "./components/MonacoEditor";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { LspMessageDialog } from "./components/LspMessageDialog";
import { LspSymbolResultsDialog } from "./components/LspSymbolResultsDialog";
import { VSCodeLayout } from "./layouts/VSCodeLayout";
import { CursorLayout } from "./layouts/CursorLayout";

export function App() {
  const ready = useStore((s) => s.ready);
  const theme = useStore((s) => s.settings["workbench.theme"]);
  const language = useStore((s) => s.settings["workbench.language"]);
  const layout = useStore((s) => s.settings["workbench.layout"]);

  // One-time bootstrap + LSP provider registration.
  useEffect(() => {
    void useStore.getState().bootstrap();
    setupLspMonaco();
    setupMonacoFileSync();
  }, []);

  // Apply theme + language to the document root.
  useEffect(() => {
    const el = document.documentElement;
    el.className = theme;
    el.dataset.theme = theme;
    el.lang = language;
  }, [theme, language]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const debugSession = s.debug.activeSessionId
        ? s.debug.sessions[s.debug.activeSessionId]
        : undefined;
      if (e.key === "F5") {
        e.preventDefault();
        if (e.shiftKey) void s.stopDebug();
        else if (debugSession?.status === "stopped") void s.debugContinue();
        else if (
          !debugSession ||
          debugSession.status === "terminated" ||
          debugSession.status === "error"
        ) void s.startDebug();
        return;
      }
      if (e.key === "F9") {
        const active = s.tabs.find((tab) => tab.id === s.activeTabId);
        if (active?.kind === "file" && active.path) {
          e.preventDefault();
          void s.toggleBreakpoint(active.path, s.cursor.line);
        }
        return;
      }
      if (e.key === "F10" && debugSession?.status === "stopped") {
        e.preventDefault();
        void s.debugStep("next");
        return;
      }
      if (e.key === "F11" && debugSession?.status === "stopped") {
        e.preventDefault();
        void s.debugStep(e.shiftKey ? "stepOut" : "stepIn");
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "p") {
        e.preventDefault();
        if (e.shiftKey && !s.paletteOpen) {
          s.openPalette();
          // Seed command mode on next tick via the palette's own input.
          queueMicrotask(() => {
            const input = document.querySelector<HTMLInputElement>(".palette input");
            if (input) {
              input.value = ">";
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          });
        } else {
          s.paletteOpen ? s.closePalette() : s.openPalette();
        }
      } else if (key === "b") {
        e.preventDefault();
        s.toggleSidebar();
      } else if (key === "j" || e.key === "`") {
        e.preventDefault();
        s.togglePanel();
      } else if (key === ",") {
        e.preventDefault();
        s.openSpecial("settings");
      } else if (key === "s") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("logos:save"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Route native-menu actions (dispatched from the main process) to the store.
  // Role items (undo/copy/zoom/quit) never arrive here — Electron handles them.
  useEffect(() => {
    const off = window.logos.app.onMenuAction((action: MenuAction) => {
      const s = useStore.getState();
      switch (action) {
        case "file.new":
          void window.logos.dialog.saveFile(s.root ?? undefined).then(async (p) => {
            if (!p) return;
            await window.logos.fs.createFile(p, "");
            s.openFile(p);
          });
          break;
        case "file.openFolder":
          void s.openFolder();
          break;
        case "file.openFile":
          void window.logos.dialog.openFile().then((p) => {
            if (p) s.openFile(p);
          });
          break;
        case "file.save":
          window.dispatchEvent(new CustomEvent("logos:save"));
          break;
        case "file.closeEditor":
          if (s.activeTabId) void closeTabSafely(s.activeTabId);
          break;
        case "view.commandPalette":
          s.paletteOpen ? s.closePalette() : s.openPalette();
          break;
        case "view.toggleSidebar":
          s.toggleSidebar();
          break;
        case "view.togglePanel":
          s.togglePanel();
          break;
        case "view.explorer":
          s.setSidebarView("explorer");
          break;
        case "view.search":
          s.setSidebarView("search");
          break;
        case "view.git":
          s.setSidebarView("git");
          break;
        case "view.agent":
          s.setSidebarView("agent");
          break;
        case "git.commit":
          // Surface the SCM view, then ask the panel to commit its current message.
          s.setSidebarView("git");
          window.dispatchEvent(new CustomEvent("logos:menu:git-commit"));
          break;
        case "git.fetch":
          void s.gitFetch();
          break;
        case "git.pull":
          void s.gitPull();
          break;
        case "git.push":
          void s.gitPush();
          break;
        case "git.sync":
          void s.gitSync();
          break;
        case "git.refresh":
          void s.refreshGit();
          break;
        case "terminal.new":
          void s.newTerminal();
          break;
        case "settings.open":
          s.openSpecial("settings");
          break;
        case "help.about":
          void window.logos.app.versions().then((v) =>
            notifyInfo(
              `Logos ${v.logos}`,
              `Electron ${v.electron} · Node ${v.node} · Chrome ${v.chrome}`,
            ),
          );
          break;
      }
    });
    return off;
  }, []);

  if (!ready) {
    return (
      <div
        className="welcome"
        style={{ height: "100vh", background: "var(--background)" }}
      >
        <h1>Logos</h1>
        <div className="tagline">Think fast, build faster</div>
      </div>
    );
  }

  return (
    <div className="workbench">
      <TitleBar />
      {layout === "cursor" ? <CursorLayout /> : <VSCodeLayout />}
      <StatusBar />
      <CommandPalette />
      <LspMessageDialog />
      <LspSymbolResultsDialog />
      <Toast.Provider placement="bottom end" />
    </div>
  );
}
