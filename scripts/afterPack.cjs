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
};
