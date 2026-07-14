import { defineConfig } from "@lightning-js/lightning";
import baseConfig from "./lightning.config";

const coverageTestFiles = [
  "src/electron/services/fs.test.ts",
  "src/electron/services/git.test.ts",
  "src/electron/services/settings.test.ts",
  "src/electron/services/terminal.test.ts",
  "src/electron/services/workspace.test.ts",
  "src/i18n/locales.test.ts",
  "src/lib/language.test.ts",
  "src/lib/lsp-utils.test.ts",
  "src/lib/workspaceFiles.test.ts",
];

export default defineConfig({
  ...baseConfig,
  projects: [
    {
      name: "supplemental",
      test: {
        exclude: coverageTestFiles,
        // Run every other test without letting incidental imports skew V8 counts.
        coverage: { include: [], reporter: [] },
      },
    },
    {
      name: "coverage",
      test: {
        include: coverageTestFiles,
      },
    },
  ],
});
