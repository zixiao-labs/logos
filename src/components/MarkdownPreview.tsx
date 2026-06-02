import { useEffect, useState } from "react";
import { marked } from "marked";

/** Minimal sanitiser: strip script/iframe blocks and inline event handlers. */
function sanitize(html: string): string {
  return html
    .replace(/<\/?(script|iframe|object|embed)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

export function MarkdownPreview({ path }: { path: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function render() {
      const md = await window.logos.fs.readFile(path).catch(() => "");
      const out = marked.parse(md, { async: false }) as string;
      if (!cancelled) setHtml(sanitize(out));
    }
    void render();
    const off = window.logos.fs.onWatchEvent((e) => {
      if (e.path === path) void render();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [path]);

  return (
    <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
