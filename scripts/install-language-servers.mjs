// Stages the language servers that Logos ships inside the installer.
//
// electron-builder copies `build/language-servers/` to the app's
// `resources/language-servers/` (see the `extraResources` entry in
// package.json). At runtime `electron/services/lsp.ts` looks for servers under
// `process.resourcesPath/language-servers/node_modules/.bin/*` BEFORE falling
// back to the npm-managed userData dir — so a packaged app works offline with
// no Node/npm on PATH (the documented G1 release blocker).
//
// This MUST run on each platform's build runner: npm writes OS-specific `.bin`
// shims (`.cmd` wrappers on Windows, symlinks elsewhere), so the staged tree
// has to be produced on the same OS that packages it.
//
// Four npm packages cover all six server ids in the lsp.ts registry:
//   typescript-language-server  -> typescript, javascript
//   pyright                     -> python
//   vscode-langservers-extracted-> json, html, css
//   bash-language-server        -> bash
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

// The `.bin` entries lsp.ts resolves (REGISTRY[].bin). All must exist after the
// install or the bundle is broken — fail the build rather than ship it.
const EXPECTED_BINS = [
  "typescript-language-server",
  "pyright-langserver",
  "vscode-json-language-server",
  "vscode-html-language-server",
  "vscode-css-language-server",
  "bash-language-server",
];

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const binExt = process.platform === "win32" ? ".cmd" : "";

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
const res = spawnSync(
  npmCmd,
  [
    "install",
    ...PACKAGES.map((p) => `${p}@latest`),
    "--prefix",
    SERVERS_DIR, // keep the install tree rooted here — no hoisting above it
    "--no-save",
    "--no-audit",
    "--no-fund",
    "--workspaces=false",
    "--install-strategy=nested",
  ],
  { cwd: SERVERS_DIR, stdio: "inherit", shell: false },
);

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
