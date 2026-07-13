import { defineConfig } from "@lightning-js/lightning";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "inline",
    coverage: {
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: [
        "src/electron/services/fs.ts",
        "src/electron/services/git.ts",
        "src/electron/services/settings.ts",
        "src/electron/services/terminal.ts",
        "src/electron/services/workspace.ts",
        "src/i18n/locales.ts",
        "src/lib/language.ts",
        "src/lib/lsp-utils.ts",
        "src/lib/workspaceFiles.ts",
      ],
      thresholds: {
        lines: 95,
        functions: 90,
        branches: 95,
        statements: 95,
      },
    },
  },
});
