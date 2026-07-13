import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@lightning-js/lightning";
import type { DirListing } from "../shared/types";
import { invalidateWorkspaceFiles, listWorkspaceFiles } from "./workspaceFiles";

function directory(name: string, path: string) {
  return { name, path, type: "directory" as const };
}

function file(name: string, path: string) {
  return { name, path, type: "file" as const, hasChildren: false };
}

describe("listWorkspaceFiles", () => {
  beforeEach(() => invalidateWorkspaceFiles());

  afterEach(() => {
    invalidateWorkspaceFiles();
    vi.unstubAllGlobals();
  });

  it("walks recursively while skipping generated and dependency directories", async () => {
    const listings = new Map<string, DirListing>([
      [
        "/root",
        {
          path: "/root",
          entries: [
            directory("src", "/root/src"),
            directory("node_modules", "/root/node_modules"),
            directory(".git", "/root/.git"),
            file("README.md", "/root/README.md"),
          ],
        },
      ],
      [
        "/root/src",
        {
          path: "/root/src",
          entries: [file("main.ts", "/root/src/main.ts")],
        },
      ],
    ]);
    const visited: string[] = [];
    vi.stubGlobal("window", {
      logos: {
        fs: {
          readDir: async (path: string) => {
            visited.push(path);
            return listings.get(path)!;
          },
        },
      },
    });

    expect(await listWorkspaceFiles("/root")).toEqual([
      "/root/src/main.ts",
      "/root/README.md",
    ]);
    expect(visited).toEqual(["/root", "/root/src"]);
  });

  it("honors limits and ignores unreadable directories", async () => {
    vi.stubGlobal("window", {
      logos: {
        fs: {
          readDir: async (path: string): Promise<DirListing> => {
            if (path === "/root/broken") throw new Error("permission denied");
            return {
              path,
              entries: [
                directory("broken", "/root/broken"),
                file("one", "/root/one"),
                file("two", "/root/two"),
                file("three", "/root/three"),
              ],
            };
          },
        },
      },
    });

    expect(await listWorkspaceFiles("/root", 2)).toEqual([
      "/root/one",
      "/root/two",
    ]);
  });

  it("caches by root until invalidated or expired", async () => {
    let calls = 0;
    vi.stubGlobal("window", {
      logos: {
        fs: {
          readDir: async (path: string): Promise<DirListing> => {
            calls++;
            return { path, entries: [file(`file-${calls}`, `${path}/${calls}`)] };
          },
        },
      },
    });

    expect(await listWorkspaceFiles("/root")).toEqual(["/root/1"]);
    expect(await listWorkspaceFiles("/root")).toEqual(["/root/1"]);
    expect(calls).toBe(1);

    invalidateWorkspaceFiles("/root");
    expect(await listWorkspaceFiles("/root")).toEqual(["/root/2"]);
    expect(await listWorkspaceFiles("/root", 8000, 0)).toEqual(["/root/3"]);
  });
});
