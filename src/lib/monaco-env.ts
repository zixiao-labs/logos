// Tell Monaco where to load its web-worker bundles from.
//
// nasti's `monacoEditorPlugin` pre-builds the workers into
// `renderer/monacoeditorwork/` and, in DEV, injects a `getWorkerUrl` shim via a
// `transformIndexHtml` hook. But nasti's *production* build does not run
// user-plugin `transformIndexHtml` hooks, so that shim never reaches the
// packaged index.html — Monaco then throws "You must define a function
// MonacoEnvironment.getWorkerUrl or MonacoEnvironment.getWorker" the moment a
// language worker is needed.
//
// Setting it here makes the renderer self-sufficient in both modes. We resolve
// against `document.baseURI`, so the URL is correct regardless of base:
//   dev  -> http://localhost:<port>/monacoeditorwork/<label>.worker.js  (served by the plugin's dev middleware)
//   prod -> file://.../dist/renderer/monacoeditorwork/<label>.worker.js (loaded from disk by loadFile)
//
// Keep these labels in sync with `languageWorkers` in nasti.config.ts.
const WORKER_LABELS = new Set([
  "editorWorkerService",
  "css",
  "html",
  "json",
  "typescript",
]);

self.MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string): string {
    const name = WORKER_LABELS.has(label) ? label : "editorWorkerService";
    return new URL(`monacoeditorwork/${name}.worker.js`, document.baseURI).href;
  },
};
