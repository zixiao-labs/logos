// Stages Microsoft's MIT-licensed JavaScript debug adapter for Logos.
//
// VS Code ships ms-vscode.js-debug as a built-in extension. Logos does not load
// that extension (its extension host is intentionally separate), but the
// extension's DAP executable is standalone. We extract the pinned DAP release and run
// src/dapDebugServer.js directly for Node.js, Chrome and Electron sessions.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract as extractTar } from "tar";

// Pinned to the built-in extension in the VS Code reference checkout's
// product.json. The checksum makes the release build reproducible and fails
// closed if the downloaded asset is changed.
const VERSION = "1.117.0";
const SHA256 = "ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772";
const REPOSITORY = "microsoft/vscode-js-debug";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTERS_DIR = join(ROOT, "build", "debug-adapters");
const DESTINATION = join(ADAPTERS_DIR, "js-debug");
const ENTRY = join(DESTINATION, "src", "dapDebugServer.js");
const VERSION_FILE = join(DESTINATION, ".logos-version");
const RUNTIME_MANIFEST = join(DESTINATION, "package.json");
const TEMP_DIR = join(ADAPTERS_DIR, ".js-debug-extract");
const ARCHIVE_PATH = join(ADAPTERS_DIR, `js-debug-dap-${VERSION}.tar.gz`);

function log(message) {
  console.log(`[install-debug-adapters] ${message}`);
}

function headers(accept) {
  return {
    Accept: accept,
    "User-Agent": "Logos Build",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
}

async function checkedFetch(url, accept) {
  const response = await fetch(url, { headers: headers(accept), redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} while downloading ${url}`);
  }
  return response;
}

function isCurrent() {
  try {
    return existsSync(ENTRY) && readFileSync(VERSION_FILE, "utf8").trim() === VERSION;
  } catch {
    return false;
  }
}

function ensureRuntimeManifest() {
  // Logos itself is an ESM package, while js-debug's bundled server is
  // CommonJS. Keep Node from inheriting the root package's module type.
  writeFileSync(
    RUNTIME_MANIFEST,
    `${JSON.stringify(
      {
        name: "logos-js-debug-adapter",
        version: VERSION,
        private: true,
        type: "commonjs",
      },
      null,
      2,
    )}\n`,
  );
}

async function downloadAdapter() {
  const release = await checkedFetch(
    `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${VERSION}`,
    "application/vnd.github+json",
  ).then((response) => response.json());
  const asset = release.assets?.find((candidate) =>
    /^js-debug-dap.*\.tar\.gz$/i.test(candidate.name ?? ""),
  );
  if (!asset?.url) {
    const assets = release.assets?.map((candidate) => candidate.name).join(", ");
    throw new Error(
      `No standalone DAP asset found in ${REPOSITORY} v${VERSION}; assets: ${assets}`,
    );
  }
  log(`downloading ${asset.name}`);
  const bytes = Buffer.from(
    await checkedFetch(asset.url, "application/octet-stream").then((response) =>
      response.arrayBuffer(),
    ),
  );
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== SHA256) {
    throw new Error(`DAP archive checksum mismatch: expected ${SHA256}, received ${actual}`);
  }
  writeFileSync(ARCHIVE_PATH, bytes);
}

function findEntry(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findEntry(candidate);
      if (nested) return nested;
    } else if (entry.name === "dapDebugServer.js") {
      return candidate;
    }
  }
  return null;
}

async function extractAdapter() {
  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(TEMP_DIR, { recursive: true });
  await extractTar({ file: ARCHIVE_PATH, cwd: TEMP_DIR, strict: true });
  const entry = findEntry(TEMP_DIR);
  if (!entry) {
    throw new Error("Downloaded DAP archive does not contain dapDebugServer.js");
  }
  const extension = dirname(dirname(entry));
  rmSync(DESTINATION, { recursive: true, force: true });
  renameSync(extension, DESTINATION);
  ensureRuntimeManifest();
  writeFileSync(VERSION_FILE, `${VERSION}\n`);
  rmSync(TEMP_DIR, { recursive: true, force: true });
  rmSync(ARCHIVE_PATH, { force: true });
}

mkdirSync(ADAPTERS_DIR, { recursive: true });
if (isCurrent()) {
  ensureRuntimeManifest();
  log(`js-debug ${VERSION} is already staged`);
} else {
  await downloadAdapter();
  try {
    await extractAdapter();
  } catch (error) {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    throw error;
  }
  log(`OK — js-debug ${VERSION} staged in ${DESTINATION}`);
}
