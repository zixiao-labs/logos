import { defineConfig, monacoEditorPlugin } from "@nasti-toolchain/nasti";

export default defineConfig({
  framework: "react",
  target: "electron",
  plugins: [
    // Pre-bundles Monaco's web workers and excludes monaco-editor from the
    // dev watcher (avoids EMFILE). No glue code needed in app source.
    monacoEditorPlugin({
      languageWorkers: [
        "editorWorkerService",
        "css",
        "html",
        "json",
        "typescript",
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": "src",
      "@shared": "src/shared",
      // Route monaco-editor through Nasti's per-file dev pipeline instead of the
      // bare-specifier dep pre-bundler. The pre-bundler runs rolldown with no
      // plugins, so it inlines Monaco's ~98 `import "*.css"` statements and dies
      // with "Bundling CSS is no longer supported" — the renderer then blanks to
      // a black screen. Aliasing the bare specifier to the on-disk ESM entry
      // makes it resolve to a /node_modules/... URL, which IS served file-by-file
      // through cssPlugin (each .css -> injected <style>). editor.main.js
      // re-exports the full API + language contributions, so `import * as monaco
      // from "monaco-editor"` keeps working unchanged.
      "monaco-editor": "node_modules/monaco-editor/esm/vs/editor/editor.main.js",
    },
  },
  electron: {
    main: "src/electron/main.ts",
    preload: "src/electron/preload.ts",
    mainFormat: "cjs",
    preloadFormat: "cjs",
    nodeTarget: "node22",
    minVersion: 41,
    // Native addons and modules that spawn their own subprocesses must stay
    // external so they are `require`d from node_modules at runtime instead of
    // being inlined by the bundler.
    external: [
      "node-pty",
      "simple-git",
      "@anthropic-ai/claude-agent-sdk",
      "vscode-jsonrpc",
      "vscode-jsonrpc/node",
    ],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
