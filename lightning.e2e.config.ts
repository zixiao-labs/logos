import { defineConfig } from "@lightning-js/lightning";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

const browserRuntimeUrl = new URL(
  "./node_modules/@lightning-js/lightning/dist/browser-runtime.mjs",
  import.meta.url,
);
const browserRuntime = `
if (typeof window !== "undefined") {
  window.$RefreshReg$ = window.$RefreshReg$ || (() => {});
  window.$RefreshSig$ = window.$RefreshSig$ || (() => (type) => type);
  window.__vite_plugin_react_preamble_installed__ = true;
}
${readFileSync(browserRuntimeUrl, "utf8")}`;

export default defineConfig({
  framework: "react",
  server: { hmr: false },
  plugins: [
    {
      name: "logos:lightning-browser-runtime",
      enforce: "pre",
      resolveId(source) {
        if (
          source === "@lightning-js/lightning" ||
          source === "/@modules/@lightning-js/lightning"
        ) {
          return "\0logos:lightning-browser-runtime";
        }
        return null;
      },
      load(id) {
        return id === "\0logos:lightning-browser-runtime" ? browserRuntime : null;
      },
      configureServer(server) {
        // Lightning's in-page runner imports this stable URL. Nasti 2.0's bare
        // module middleware currently wins before Lightning's virtual module,
        // so serve the package's browser bundle explicitly for E2E only.
        const serveBrowserRuntime = (
          request: IncomingMessage,
          response: ServerResponse,
          next: () => void,
        ) => {
          if (request.url?.split("?", 1)[0] !== "/@modules/@lightning-js/lightning") {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          response.end(browserRuntime);
        };
        const middlewareStack = server.middlewares.stack as
          | Array<{ route: string; handle: typeof serveBrowserRuntime }>
          | undefined;
        if (middlewareStack) {
          middlewareStack.unshift({ route: "", handle: serveBrowserRuntime });
        } else {
          server.middlewares.use(serveBrowserRuntime);
        }
      },
    },
  ],
  test: {
    include: ["e2e/**/*.test.tsx"],
    testTimeout: 20_000,
    browser: {
      enabled: true,
      provider: "playwright",
      browsers: ["chromium"],
      headless: true,
    },
  },
});
