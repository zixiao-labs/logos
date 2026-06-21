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

  // Resize to the host, then force a FULL repaint. FitAddon's fit() only clears
  // the renderer when the grid dimensions actually change; on a font-size change
  // that keeps the same rows/cols it skips the clear, so the DOM renderer leaves
  // ghost glyphs that "bleed through" the background. The explicit refresh() and
  // the opaque host background (see app.css) close both gaps. Returns true once
  // the terminal is actually laid out (non-zero size), false while hidden.
  function refit(): boolean {
    const fit = fitRef.current;
    const term = termRef.current;
    const host = hostRef.current;
    if (!fit || !term || !host) return false;
    // Skip hidden / not-yet-laid-out terminals (inactive tabs are display:none):
    // fitting a zero-size box can resize the pty to a tiny 2x1 grid.
    if (host.clientHeight === 0 || host.clientWidth === 0) return false;
    try {
      fit.fit();
    } catch {
      return false; // host has no size yet (e.g. inactive tab => display:none)
    }
    window.logos.terminal.resize(id, term.cols, term.rows);
    term.refresh(0, term.rows - 1);
    return true;
  }

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
    termRef.current = term;
    fitRef.current = fit;
    refit();

    const offData = window.logos.terminal.onData(id, (d) => term.write(d));
    const inputSub = term.onData((d) => window.logos.terminal.write(id, d));
    const offExit = window.logos.terminal.onExit(id, () =>
      term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"),
    );

    const ro = new ResizeObserver(() => refit());
    ro.observe(hostRef.current);

    return () => {
      offData();
      inputSub.dispose();
      offExit();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Font-size change: apply the option, then fit on the NEXT frame — the renderer
  // recomputes its cell metrics asynchronously, and fitting against stale (smaller)
  // metrics over-counts rows so the last line gets clipped at the bottom edge.
  // A second frame guarantees the new cell height is in effect before measuring.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(refit);
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      if (refit()) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id]);

  return (
    <div className="terminal-view" style={{ display: active ? "block" : "none" }}>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
