import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Must run before anything imports monaco-editor (configures worker URLs).
import "./lib/monaco-env";
import "./theme/xterm.css";
import "./theme/globals.css";
import "./theme/app.css";
import { App } from "./App";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
