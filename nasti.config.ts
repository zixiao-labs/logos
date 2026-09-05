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
    // Packaged builds load the renderer from disk via file:// (see main.ts
    // `loadFile`). With the default base of "/", the emitted index.html points
    // at the entry as `/assets/main.<hash>.js`, which under file:// resolves to
    // the filesystem ROOT and 404s — a black screen with net::ERR_FILE_NOT_FOUND.
    // Use a relative base for `build` only, so every asset resolves next to
    // index.html; dev keeps "/" so the dev server + worker middleware are unaffected.
    {
      name: "logos:relative-base-for-packaged-renderer",
      config(_config, env) {
        if (env.command === "build") return { base: "./" };
      },
    },
  ],
  resolve: {
    alias: {
      // The package's browser export is UMD; select its ESM build explicitly.
      "monaco-vim": "node_modules/monaco-vim/dist/index.mjs",
      "monaco-editor/esm": "node_modules/monaco-editor/esm",
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
      "monaco-editor":
        "node_modules/monaco-editor/esm/vs/editor/editor.main.js",
    },
  },
  electron: {
    main: "src/electron/main.ts",
    preload: "src/electron/preload.ts",
    // Keep Chromium's inspector available for the Logos Electron launch
    // configuration. The renderer child session in .logos/launch.json uses
    // the same port.
    electronArgs: ["--remote-debugging-port=9222"],
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
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk/client/stdio.js",
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
      "vscode-jsonrpc",
      "vscode-jsonrpc/node",
      "electron-updater",
    ],
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
