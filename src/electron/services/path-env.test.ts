import { describe, expect, it } from "@lightning-js/lightning";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { augmentPath } from "./path-env";

describe("path environment", () => {
  it("adds the NVM default version before other installed versions", () => {
    if (process.platform === "win32") return;
    const nvmDir = mkdtempSync(path.join(os.tmpdir(), "logos-nvm-"));
    const defaultBin = path.join(nvmDir, "versions", "node", "v20.12.2", "bin");
    const newestBin = path.join(nvmDir, "versions", "node", "v22.4.1", "bin");
    mkdirSync(defaultBin, { recursive: true });
    mkdirSync(newestBin, { recursive: true });
    mkdirSync(path.join(nvmDir, "alias"), { recursive: true });
    writeFileSync(path.join(defaultBin, "node"), "");
    writeFileSync(path.join(newestBin, "node"), "");
    writeFileSync(path.join(nvmDir, "alias", "default"), "20\n");

    try {
      const env: NodeJS.ProcessEnv = {
        HOME: path.join(nvmDir, "home"),
        NVM_DIR: nvmDir,
        PATH: "/custom/bin:/usr/bin",
      };
      augmentPath(env);
      const entries = env.PATH!.split(":");
      expect(entries.indexOf(defaultBin)).toBeGreaterThan(
        entries.indexOf("/custom/bin"),
      );
      expect(entries.indexOf(defaultBin)).toBeLessThan(entries.indexOf(newestBin));
      expect(entries.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    } finally {
      rmSync(nvmDir, { recursive: true, force: true });
    }
  });

  it("follows NVM aliases and preserves NVM_BIN", () => {
    if (process.platform === "win32") return;
    const nvmDir = mkdtempSync(path.join(os.tmpdir(), "logos-nvm-alias-"));
    const inheritedBin = path.join(nvmDir, "active", "bin");
    const ltsBin = path.join(nvmDir, "versions", "node", "v18.20.4", "bin");
    mkdirSync(inheritedBin, { recursive: true });
    mkdirSync(ltsBin, { recursive: true });
    mkdirSync(path.join(nvmDir, "alias", "lts"), { recursive: true });
    writeFileSync(path.join(ltsBin, "node"), "");
    writeFileSync(path.join(nvmDir, "alias", "default"), "lts/*\n");
    writeFileSync(path.join(nvmDir, "alias", "lts", "*"), "18.20.4\n");

    try {
      const env: NodeJS.ProcessEnv = {
        NVM_DIR: nvmDir,
        NVM_BIN: inheritedBin,
        PATH: "/usr/bin",
      };
      augmentPath(env);
      const entries = env.PATH!.split(":");
      expect(entries).toContain(inheritedBin);
      expect(entries).toContain(ltsBin);
      expect(entries.indexOf(inheritedBin)).toBeLessThan(entries.indexOf(ltsBin));
    } finally {
      rmSync(nvmDir, { recursive: true, force: true });
    }
  });
});
