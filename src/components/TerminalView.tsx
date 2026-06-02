import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useStore } from "../state/store";

const THEME = {
  background: "#121215",
  foreground: "#d4d4d8",
  cursor: "#a78bfa",
  selectionBackground: "#33335a",
  black: "#1c1c22",
  brightBlack: "#4a4a55",
};

export function TerminalView({ id, active }: { id: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fontSize = useStore((s) => s.settings["terminal.fontSize"]);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      fontSize,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--mono-font")
        .trim(),
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    try {
      fit.fit();
    } catch {
      /* not yet sized */
    }
    termRef.current = term;
    fitRef.current = fit;

    const offData = window.logos.terminal.onData(id, (d) => term.write(d));
    const inputSub = term.onData((d) => window.logos.terminal.write(id, d));
    const offExit = window.logos.terminal.onExit(id, () =>
      term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"),
    );
    window.logos.terminal.resize(id, term.cols, term.rows);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        window.logos.terminal.resize(id, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(hostRef.current);

    return () => {
      offData();
      inputSub.dispose();
      offExit();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    });
  }, [fontSize]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          window.logos.terminal.resize(id, term.cols, term.rows);
          term.focus();
        }
      } catch {
        /* ignore */
      }
    });
  }, [active, id]);

  return (
    <div
      className="terminal-view"
      ref={hostRef}
      style={{ display: active ? "block" : "none" }}
    />
  );
}
