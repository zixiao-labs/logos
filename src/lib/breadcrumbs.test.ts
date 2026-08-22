import { describe, expect, it } from "@lightning-js/lightning";
import {
  buildBreadcrumbs,
  canonicalPath,
  directoriesToReveal,
  workspaceRootForPath,
} from "./breadcrumbs";

describe("editor breadcrumbs", () => {
  it("builds clickable paths relative to the owning workspace folder", () => {
    expect(
      buildBreadcrumbs(
        "/workspace/packages/editor/src/EditorArea.tsx",
        ["/workspace", "/workspace/packages/editor"],
        "/workspace",
      ),
    ).toEqual([
      {
        label: "src",
        path: "/workspace/packages/editor/src",
        kind: "folder",
      },
      {
        label: "EditorArea.tsx",
        path: "/workspace/packages/editor/src/EditorArea.tsx",
        kind: "file",
      },
    ]);
  });

  it("normalizes Windows paths and matches drive letters case-insensitively", () => {
    expect(canonicalPath("C:\\work\\src\\main.ts")).toBe("C:/work/src/main.ts");
    expect(canonicalPath("C:\\")).toBe("C:/");
    expect(
      workspaceRootForPath("c:/work/src/main.ts", ["C:\\work"], null),
    ).toBe("C:/work");
    expect(workspaceRootForPath("/src/main.ts", ["/"], null)).toBe("/");
    expect(buildBreadcrumbs("/src/main.ts", ["/"], null)[0]?.path).toBe(
      "/src",
    );
  });

  it("returns every directory that must be expanded to reveal a file", () => {
    expect(
      directoriesToReveal(
        "/workspace/src/components/EditorArea.tsx",
        false,
        "/workspace",
      ),
    ).toEqual([
      "/workspace",
      "/workspace/src",
      "/workspace/src/components",
    ]);
    expect(directoriesToReveal("C:\\src\\main.ts", false, "C:\\")).toEqual([
      "C:/",
      "C:/src",
    ]);
  });
});
