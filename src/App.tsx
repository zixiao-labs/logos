import { useEffect } from "react";
import { useStore } from "./state/store";
import { setupLspMonaco } from "./lib/lsp-monaco";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
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
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const s = useStore.getState();
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
    </div>
  );
}
