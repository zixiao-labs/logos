// Stages the language servers that Logos ships inside the installer.
//
// electron-builder copies `build/language-servers/` to the app's
// `resources/language-servers/` (see the `extraResources` entry in
// package.json). At runtime `electron/services/lsp.ts` searches the userData
// managed tree first, then falls back to this bundled `resources/language-servers`
// tree. It resolves each server's real JS entry file directly, so packaged apps
// work offline with no Node/npm on PATH.
//
// This MUST run on each platform's build runner because some npm packages ship
// platform-specific files and optional dependencies.
//
// Four npm packages cover the npm-backed server ids in the lsp.ts registry:
//   typescript-language-server  -> typescript, javascript
//   pyright                     -> python
//   vscode-langservers-extracted-> json, html, css
//   bash-language-server        -> bash
//
// Native binary servers (gopls, rust-analyzer) are installed on demand into the
// same managed tree at runtime.
//
// typescript-language-server ships no tsserver of its own, so the `typescript`
// package is staged beside it (and handed to the server as
// `tsserver.fallbackPath` in lsp.ts) — otherwise it errors on initialize when
// the opened workspace has no local TypeScript.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_DIR = join(ROOT, "build", "language-servers");

const PACKAGES = [
  "typescript-language-server",
  "typescript", // tsserver runtime for typescript-language-server (it bundles none)
  "pyright",
  "vscode-langservers-extracted",
  "bash-language-server",
];

// The npm `.bin` entries corresponding to the Node-based registry entries. All
// must exist after the install or the bundle is broken — fail the build rather
// than ship it.
const EXPECTED_BINS = [
  "typescript-language-server",
  "pyright-langserver",
  "vscode-json-language-server",
  "vscode-html-language-server",
  "vscode-css-language-server",
  "bash-language-server",
];

const binExt = process.platform === "win32" ? ".cmd" : "";

const npmInstallArgs = [
  "install",
  ...PACKAGES.map((p) => `${p}@latest`),
  "--prefix",
  SERVERS_DIR, // keep the install tree rooted here — no hoisting above it
  "--no-save",
  "--no-audit",
  "--no-fund",
  "--workspaces=false",
  "--install-strategy=nested",
];

function npmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...npmInstallArgs],
      shell: false,
    };
  }

  // Windows CI can fail with EINVAL when Node tries to CreateProcess `npm.cmd`
  // directly. The npm CLI path above is preferred; this shell fallback keeps
  // direct `node scripts/install-language-servers.mjs` invocations working too.
  if (process.platform === "win32") {
    return { command: "npm", args: npmInstallArgs, shell: true };
  }

  return { command: npmExecPath || "npm", args: npmInstallArgs, shell: false };
}

function log(msg) {
  console.log(`[install-language-servers] ${msg}`);
}

mkdirSync(SERVERS_DIR, { recursive: true });

// A private, workspace-free manifest isolates this install from the repo root's
// `workspaces` config so npm never hoists the servers into the project's own
// node_modules.
writeFileSync(
  join(SERVERS_DIR, "package.json"),
  JSON.stringify({ name: "logos-language-servers", private: true }, null, 2),
);

log(`installing ${PACKAGES.length} packages into ${SERVERS_DIR}`);
const npm = npmInvocation();
const res = spawnSync(npm.command, npm.args, {
  cwd: SERVERS_DIR,
  stdio: "inherit",
  shell: npm.shell,
});

if (res.error) {
  console.error(`[install-language-servers] npm spawn failed:`, res.error);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`[install-language-servers] npm exited with code ${res.status}`);
  process.exit(res.status ?? 1);
}

const binDir = join(SERVERS_DIR, "node_modules", ".bin");
const missing = EXPECTED_BINS.filter((b) => !existsSync(join(binDir, b + binExt)));
if (missing.length) {
  console.error(
    `[install-language-servers] expected server binaries missing in ${binDir}: ${missing.join(", ")}`,
  );
  process.exit(1);
}

// typescript-language-server locates tsserver.js in a sibling `typescript`
// package; without it the server throws on initialize. Verify it landed.
const tsserverPath = join(
  SERVERS_DIR,
  "node_modules",
  "typescript",
  "lib",
  "tsserver.js",
);
if (!existsSync(tsserverPath)) {
  console.error(
    `[install-language-servers] typescript not staged: missing ${tsserverPath}`,
  );
  process.exit(1);
}

log(`OK — ${EXPECTED_BINS.length} server binaries staged in ${binDir}`);
