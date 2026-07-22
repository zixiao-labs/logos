import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "rolldown";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "build", "debug-mcp");
const outputFile = path.join(outputDirectory, "server.mjs");

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });
await build({
  input: path.join(root, "packages", "debug-mcp", "server.mjs"),
  external: id => id.startsWith("node:"),
  output: {
    file: outputFile,
    format: "es",
    minify: true,
  },
});
console.log(`[debug-mcp] bundled ${path.relative(root, outputFile)}`);
