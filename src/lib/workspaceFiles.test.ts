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

  it("shares concurrent scans instead of multiplying directory IPC", async () => {
    let reads = 0;
    let releaseRead = false;
    let resolveRoot: ((value: DirListing) => void) | undefined;
    vi.stubGlobal("window", {
      logos: {
        fs: {
          readDir: async (path: string): Promise<DirListing> => {
            reads += 1;
            if (path.endsWith("/release")) releaseRead = true;
            return new Promise<DirListing>((resolve) => {
              resolveRoot = resolve;
            });
          },
        },
      },
    });

    const first = listWorkspaceFiles("/concurrent");
    const second = listWorkspaceFiles("/concurrent");
    expect(reads).toBe(1);
    resolveRoot?.({
      path: "/concurrent",
      entries: [
        { name: "release", path: "/concurrent/release", type: "directory" },
        { name: "index.ts", path: "/concurrent/index.ts", type: "file" },
      ],
    });

    expect(await first).toEqual(["/concurrent/index.ts"]);
    expect(await second).toEqual(["/concurrent/index.ts"]);
    expect(reads).toBe(1);
    expect(releaseRead).toBe(false);
  });

  it("does not let an invalidated scan overwrite a newer cache entry", async () => {
    const resolvers: Array<(value: DirListing) => void> = [];
    let reads = 0;
    vi.stubGlobal("window", {
      logos: {
        fs: {
          readDir: async () => {
            reads += 1;
            return new Promise<DirListing>((resolve) => resolvers.push(resolve));
          },
        },
      },
    });

    const stale = listWorkspaceFiles("/root");
    invalidateWorkspaceFiles("/root");
    const current = listWorkspaceFiles("/root");
    expect(reads).toBe(2);

    resolvers[1]?.({
      path: "/root",
      entries: [file("new.ts", "/root/new.ts")],
    });
    expect(await current).toEqual(["/root/new.ts"]);

    resolvers[0]?.({
      path: "/root",
      entries: [file("old.ts", "/root/old.ts")],
    });
    expect(await stale).toEqual(["/root/old.ts"]);
    expect(await listWorkspaceFiles("/root")).toEqual(["/root/new.ts"]);
    expect(reads).toBe(2);
  });
});
