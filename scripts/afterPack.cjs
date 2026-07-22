// Copies the staged language servers into the packaged app's Resources dir.
//
// We cannot use electron-builder's `extraResources` for this: a long-standing
// bug (electron-userland/electron-builder#3104) makes its file copier drop any
// directory named `node_modules`. The always-applied default ignores (e.g.
// `!**/node_modules/.bin`) match the `node_modules` directory itself and prune
// the whole subtree — even with a custom `filter`, and at any depth. The bundle
// is exactly such a tree (it includes pyright's own nested `node_modules`), so
// `extraResources` shipped only `package.json` and the app fell back to npm
// (the "npm exited with code -2" failure in a GUI-launched app with no Node).
//
// `afterPack` runs after file collection and before signing, so a plain
// recursive copy here bypasses the buggy filter and the result is code-signed
// as part of the app bundle. See scripts/install-language-servers.mjs for how
// `build/language-servers` is staged.
const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const src = path.join(
    context.packager.projectDir,
    "build",
    "language-servers",
  );
  if (!existsSync(path.join(src, "node_modules"))) {
    throw new Error(
      `[afterPack] ${src}/node_modules missing — run \`npm run prepackage:servers\` before packaging`,
    );
  }
  const dest = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "language-servers",
  );
  // Copy the tree but skip every `node_modules/.bin` directory: those are the
  // only symlinks in the bundle, and macOS code signing rejects them with
  // "invalid destination for symbolic link in bundle". The runtime resolves each
  // server's real entry file directly (see resolveEntry in services/lsp.ts), so
  // the .bin shims are unused dead weight anyway.
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const parts = s.split(path.sep);
      const i = parts.lastIndexOf(".bin");
      return !(i > 0 && parts[i - 1] === "node_modules");
    },
  });
  console.log(`[afterPack] bundled language servers → ${dest}`);

  const adapterSrc = path.join(
    context.packager.projectDir,
    "build",
    "debug-adapters",
  );
  const adapterEntry = path.join(
    adapterSrc,
    "js-debug",
    "src",
    "dapDebugServer.js",
  );
  if (!existsSync(adapterEntry)) {
    throw new Error(
      `[afterPack] ${adapterEntry} missing — run \`npm run prepackage:debug-adapters\` before packaging`,
    );
  }
  const adapterDest = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "debug-adapters",
  );
  cpSync(adapterSrc, adapterDest, { recursive: true });
  console.log(`[afterPack] bundled debug adapters → ${adapterDest}`);

  const debugMcpSrc = path.join(
    context.packager.projectDir,
    "build",
    "debug-mcp",
  );
  if (!existsSync(path.join(debugMcpSrc, "server.mjs"))) {
    throw new Error(
      `[afterPack] ${debugMcpSrc}/server.mjs missing — run \`npm run prepackage:debug-mcp\` before packaging`,
    );
  }
  const debugMcpDest = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "debug-mcp",
  );
  cpSync(debugMcpSrc, debugMcpDest, { recursive: true });
  console.log(`[afterPack] bundled debug MCP server → ${debugMcpDest}`);

  const agentSkillsSrc = path.join(
    context.packager.projectDir,
    ".agents",
    "skills",
  );
  const agentSkillsDest = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "agent-skills",
  );
  cpSync(agentSkillsSrc, agentSkillsDest, { recursive: true });
  console.log(`[afterPack] bundled Agent Skills → ${agentSkillsDest}`);
};
