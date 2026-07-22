import { afterEach, describe, expect, it } from "@lightning-js/lightning";
import "../src/theme/app.css";

describe("agent timeline layout", () => {
  let log: HTMLDivElement | undefined;

  afterEach(() => {
    log?.remove();
    log = undefined;
  });

  it("preserves message height and scrolls after multiple conversation turns", () => {
    log = document.createElement("div");
    log.className = "agent-log";
    log.style.width = "320px";
    log.style.height = "120px";

    for (let index = 0; index < 8; index++) {
      const entry = document.createElement("div");
      entry.className = "msg thinking";
      entry.style.height = "32px";
      entry.textContent = `Thinking ${index + 1}`;
      log.append(entry);
    }
    document.body.append(log);

    const firstEntry = log.firstElementChild as HTMLElement;
    expect(firstEntry.getBoundingClientRect().height).toBe(32);
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);

    log.scrollTop = log.scrollHeight;
    expect(log.scrollTop).toBeGreaterThan(0);
  });
});
