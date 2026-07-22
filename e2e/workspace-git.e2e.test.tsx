import { afterEach, beforeEach, describe, expect, it } from "@lightning-js/lightning";
import { createRoot, type Root } from "react-dom/client";
import { Explorer } from "../src/components/Explorer";
import { GitPanel } from "../src/components/GitPanel";
import { GitGraphPanel } from "../src/components/GitGraphPanel";
import type { LogosAPI } from "../src/shared/api";
import type { GitGraphEntry, GitStatus } from "../src/shared/types";
import { useStore } from "../src/state/store";

const APP = "/workspace/app";
const DOCS = "/workspace/docs";
const TOOLS = "/workspace/tools";

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const cleanStatus: GitStatus = {
  isRepo: true,
  branch: "main",
  ahead: 0,
  behind: 0,
  changes: [],
  clean: true,
};

const initialGraph: GitGraphEntry[] = [
  {
    hash: "2222222222222222222222222222222222222222",
    shortHash: "2222222",
    parents: ["1111111111111111111111111111111111111111"],
    refs: ["HEAD -> main"],
    message: "Add multi-root workspace",
    author: "Logos",
    date: "2026-07-21T08:00:00Z",
  },
  {
    hash: "1111111111111111111111111111111111111111",
    shortHash: "1111111",
    parents: [],
    refs: [],
    message: "Initial commit",
    author: "Logos",
    date: "2026-07-20T08:00:00Z",
  },
];

describe("multi-root workbench", () => {
  let reactRoot: Root;
  let host: HTMLDivElement;
  let graph = initialGraph;
  let gitChanged: (root: string) => void = () => undefined;
  let statusRoots: string[] = [];

  beforeEach(() => {
    host = document.createElement("div");
    host.style.height = "800px";
    document.body.append(host);
    reactRoot = createRoot(host);
    graph = initialGraph;
    statusRoots = [];

    const logos = {
      fs: {
        readDir: async (folder: string) => ({
          path: folder,
          entries: [
            {
              name: folder === APP ? "src" : "README.md",
              path: `${folder}/${folder === APP ? "src" : "README.md"}`,
              type: folder === APP ? "directory" : "file",
            },
          ],
        }),
        watch: async () => undefined,
        unwatch: async () => undefined,
        onWatchEvent: () => () => undefined,
      },
      workspace: {
        addFolder: async () => ({ folders: [APP, DOCS, TOOLS], root: APP }),
        removeFolder: async (folder: string) => {
          const folders = [APP, DOCS, TOOLS].filter(candidate => candidate !== folder);
          return { folders, root: folders[0] ?? null };
        },
        getFolders: async () => [APP, DOCS],
        recent: async () => [],
      },
      git: {
        graph: async () => graph,
        commitDetails: async (_root: string, hash: string) => ({
          ...graph.find(commit => commit.hash === hash)!,
          body: "Add workspace support\n\nThis is the expanded commit body.",
          authorEmail: "logos@example.com",
          committer: "Logos",
          committerEmail: "logos@example.com",
          committedDate: "2026-07-21T08:00:00Z",
          files: [
            {
              path: "src/workspace.ts",
              additions: 12,
              deletions: 2,
              binary: false,
            },
          ],
        }),
        status: async (root: string) => {
          statusRoots.push(root);
          return cleanStatus;
        },
        head: async () => null,
        watch: async () => undefined,
        onChanged: (listener: (root: string) => void) => {
          gitChanged = listener;
          return () => undefined;
        },
      },
    } as unknown as LogosAPI;
    Object.defineProperty(window, "logos", { configurable: true, value: logos });
    useStore.setState({
      root: APP,
      workspaceFolders: [APP, DOCS],
      gitRoot: APP,
      git: cleanStatus,
      gitHead: null,
      gitRepositories: { [APP]: { status: cleanStatus, head: null } },
    });
  });

  afterEach(() => {
    reactRoot.unmount();
    host.remove();
  });

  it("shows every workspace root and adds another root through the real Explorer action", async () => {
    reactRoot.render(<Explorer />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(host.textContent).toContain("app");
    expect(host.textContent).toContain("docs");

    const add = host.querySelector<HTMLButtonElement>('button[title="Add Folder to Workspace"]');
    expect(add).not.toBeNull();
    add!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(host.textContent).toContain("tools");
  });

  it("renders commit topology and refreshes Git Graph from watcher events", async () => {
    reactRoot.render(<GitGraphPanel />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(host.querySelector('[data-testid="git-graph"]')?.textContent).toContain(
      "Add multi-root workspace",
    );
    expect(host.textContent).toContain("HEAD -> main");

    host.querySelector<HTMLElement>(`[data-git-commit="${initialGraph[0]!.hash}"]`)!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(host.querySelector('[data-testid="git-commit-details"]')?.textContent).toContain(
      "src/workspace.ts",
    );

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commits"]')!;
    setInputValue(search, "initial");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(host.querySelector('[data-testid="git-graph"]')?.textContent).not.toContain(
      "Add multi-root workspace",
    );
    setInputValue(search, "");
    await new Promise(resolve => setTimeout(resolve, 10));

    graph = [{ ...initialGraph[0]!, message: "Realtime watcher refresh" }];
    gitChanged(APP);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(host.textContent).toContain("Realtime watcher refresh");
  });

  it("refreshes an uncached repository when the selector changes", async () => {
    reactRoot.render(<GitPanel />);
    await new Promise(resolve => setTimeout(resolve, 30));

    const select = host.querySelector<HTMLSelectElement>(".git-repository-select");
    expect(select).not.toBeNull();
    select!.value = DOCS;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(useStore.getState().gitRoot).toBe(DOCS);
    expect(statusRoots).toContain(DOCS);
  });
});
