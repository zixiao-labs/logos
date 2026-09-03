import { afterEach, beforeEach, describe, expect, it } from "@lightning-js/lightning";
import { createRoot, type Root } from "react-dom/client";
import { MultiBufferEditor } from "../src/components/MultiBufferEditor";
import { Panel } from "../src/components/Panel";
import { SearchPanel } from "../src/components/SearchPanel";
import type { MultiBufferDocument } from "../src/lib/multibuffer";
import type { LogosAPI } from "../src/shared/api";
import { useStore } from "../src/state/store";

const ROOT = "/workspace/app";

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("multibuffer consumers", () => {
  let reactRoot: Root;
  let host: HTMLDivElement;
  let originalIntersectionObserver: typeof IntersectionObserver;

  beforeEach(() => {
    originalIntersectionObserver = window.IntersectionObserver;
    host = document.createElement("div");
    host.style.height = "800px";
    document.body.append(host);
    reactRoot = createRoot(host);
    const logos = {
      fs: {
        searchText: async () => [
          {
            path: `${ROOT}/src/app.ts`,
            line: 4,
            column: 7,
            endColumn: 18,
            text: "const multibuffer = true;",
          },
          {
            path: `${ROOT}/src/other.ts`,
            line: 9,
            column: 4,
            endColumn: 15,
            text: "// multibuffer",
          },
        ],
      },
    } as unknown as LogosAPI;
    Object.defineProperty(window, "logos", { configurable: true, value: logos });
    useStore.setState({
      root: ROOT,
      workspaceFolders: [ROOT],
      tabs: [{ id: "welcome", kind: "welcome", name: "Welcome" }],
      activeTabId: "welcome",
      panelTab: "problems",
      diagnostics: {},
    });
  });

  afterEach(() => {
    reactRoot.unmount();
    host.remove();
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: originalIntersectionObserver,
    });
  });

  it("opens project text search results in a multibuffer tab", async () => {
    reactRoot.render(<SearchPanel />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Search"]',
    );
    expect(input).not.toBeNull();
    setInputValue(input!, "multibuffer");
    await new Promise((resolve) => setTimeout(resolve, 260));

    const open = host.querySelector<HTMLButtonElement>(
      '[data-testid="open-search-multibuffer"]',
    );
    expect(open?.disabled).toBe(false);
    open!.click();

    const tab = useStore
      .getState()
      .tabs.find((candidate) => candidate.kind === "multibuffer");
    expect(tab?.multiBuffer).toMatchObject({
      kind: "search",
      title: "Search: multibuffer",
    });
    expect(tab?.multiBuffer?.excerpts).toHaveLength(2);
  });

  it("lets every workspace folder search up to the global result limit", async () => {
    const limits: number[] = [];
    const folders = [`${ROOT}/one`, `${ROOT}/two`];
    const logos = {
      fs: {
        searchText: async (folder: string, _query: string, options: { maxResults: number }) => {
          limits.push(options.maxResults);
          return Array.from({ length: 600 }, (_, index) => ({
            path: `${folder}/file-${index}.ts`,
            line: 1,
            column: 1,
            endColumn: 5,
            text: "match",
          }));
        },
      },
    } as unknown as LogosAPI;
    Object.defineProperty(window, "logos", { configurable: true, value: logos });
    useStore.setState({ workspaceFolders: folders });

    reactRoot.render(<SearchPanel />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Search"]',
    );
    setInputValue(input!, "match");
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(limits).toEqual([1000, 1000]);
    expect(host.querySelector(".search-meta")?.textContent).toContain("1000");
  });

  it("loads only visible multibuffer sources with bounded concurrency", async () => {
    const observerCallbacks: IntersectionObserverCallback[] = [];
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [0];

      constructor(callback: IntersectionObserverCallback) {
        observerCallbacks.push(callback);
      }

      disconnect() {}
      observe() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve() {}
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: TestIntersectionObserver,
    });

    const reads: string[] = [];
    const rejectReads: Array<(reason?: unknown) => void> = [];
    const logos = {
      fs: {
        readFile: (path: string) =>
          new Promise<string>((_resolve, reject) => {
            reads.push(path);
            rejectReads.push(reject);
          }),
      },
    } as unknown as LogosAPI;
    Object.defineProperty(window, "logos", { configurable: true, value: logos });
    const document: MultiBufferDocument = {
      id: "lazy-sources",
      title: "Lazy sources",
      kind: "manual",
      contextLines: 0,
      excerpts: Array.from({ length: 10 }, (_, index) => ({
        id: `excerpt-${index}`,
        path: `${ROOT}/source-${index}.ts`,
        kind: "manual" as const,
        startLine: 1,
        endLine: 1,
        matches: [],
      })),
    };

    reactRoot.render(<MultiBufferEditor document={document} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveLength(0);

    for (const callback of observerCallbacks) {
      callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveLength(4);

    rejectReads[0]?.(new Error("unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveLength(5);
  });

  it("deploys all diagnostics into the same multibuffer surface", async () => {
    useStore.setState({
      diagnostics: {
        [`${ROOT}/src/app.ts`]: [
          {
            message: "Missing return type",
            severity: 2,
            startLine: 3,
            startCol: 1,
            endLine: 3,
            endCol: 6,
          },
        ],
      },
    });
    reactRoot.render(<Panel />);
    await new Promise((resolve) => setTimeout(resolve, 20));

    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="open-problems-multibuffer"]',
      )!
      .click();
    const tab = useStore
      .getState()
      .tabs.find((candidate) => candidate.id === "multibuffer:diagnostics");
    expect(tab?.multiBuffer).toMatchObject({ kind: "diagnostic", title: "Problems" });
    expect(tab?.multiBuffer?.excerpts[0]?.matches[0]).toMatchObject({
      label: "Missing return type",
      severity: 2,
    });
  });
});
