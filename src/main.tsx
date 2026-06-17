import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Must run before anything imports monaco-editor (configures worker URLs).
import "./lib/monaco-env";
// HeroUI's precompiled stylesheet (Tailwind v4, fully layered), vendored into the
// theme dir the same way as xterm.css — @heroui/styles' package exports don't
// expose the prebuilt CSS as an importable subpath. Imported FIRST so the app's
// own unlayered CSS (globals/app) always wins the cascade; globals.css already
// defines HeroUI's theme tokens for both light and dark.
import "./theme/heroui.css";
import "./theme/xterm.css";
import "./theme/globals.css";
import "./theme/app.css";
import { App } from "./App";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
