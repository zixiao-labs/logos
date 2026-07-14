import { describe, expect, it } from "@lightning-js/lightning";
import {
  parseDebugConfigurationFile,
  resolveDebugConfiguration,
  stripJsonComments,
} from "./debug-config";

describe("debug configuration", () => {
  it("parses JSONC comments and trailing commas", () => {
    const file = parseDebugConfigurationFile(`{
      // launch the active file
      "version": "0.2.0",
      "configurations": [{
        "name": "Node",
        "type": "node",
        "request": "launch",
        "url": "https://localhost/app", /* keep URL slashes */
      }],
    }`);
    expect(file.configurations).toEqual([
      {
        name: "Node",
        type: "node",
        request: "launch",
        url: "https://localhost/app",
      },
    ]);
  });

  it("preserves comment markers inside strings", () => {
    expect(stripJsonComments(`{"value":"// not a comment /* still text */"}`))
      .toContain("// not a comment /* still text */");
  });

  it("preserves trailing-comma-like text inside strings", () => {
    const file = parseDebugConfigurationFile(`{
      "configurations": [{
        "name": "value,}",
        "type": "node",
        "request": "launch",
        "args": ["value,]"],
      }],
    }`);
    expect(file.configurations[0]).toMatchObject({
      name: "value,}",
      args: ["value,]"],
    });
  });

  it("resolves workspace and active-file variables recursively", () => {
    expect(
      resolveDebugConfiguration(
        {
          name: "Current",
          type: "custom",
          request: "launch",
          program: "${file}",
          args: ["${relativeFile}", "${fileBasename}"],
          adapter: {
            type: "executable",
            command: "adapter",
            cwd: "${workspaceFolder}",
          },
        },
        {
          workspaceFolder: "/workspace/project",
          file: "/workspace/project/src/main.ts",
        },
      ),
    ).toMatchObject({
      program: "/workspace/project/src/main.ts",
      args: ["src/main.ts", "main.ts"],
      adapter: { cwd: "/workspace/project" },
    });
  });

  it("does not treat a sibling path prefix as part of the workspace", () => {
    expect(
      resolveDebugConfiguration(
        {
          name: "Sibling",
          type: "node",
          request: "launch",
          program: "${relativeFile}",
        },
        {
          workspaceFolder: "/workspace/app",
          file: "/workspace/app2/main.ts",
        },
      ),
    ).toMatchObject({ program: "/workspace/app2/main.ts" });
  });
});
