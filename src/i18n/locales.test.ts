import { describe, expect, it } from "@lightning-js/lightning";
import type { LanguageCode } from "../shared/types";
import { translate } from "./locales";

describe("translate", () => {
  it("returns localized English and Chinese strings", () => {
    expect(translate("en", "common.cancel")).toBe("Cancel");
    expect(translate("zh", "common.cancel")).toBe("取消");
    expect(translate("en", "panel.noPorts")).toBe("No forwarded ports.");
    expect(translate("zh", "panel.noPorts")).toBe("暂无转发端口。");
    expect(translate("en", "settings.inlineBlame")).toBe("Inline Blame");
    expect(translate("zh", "git.blame.uncommitted")).toBe("未提交的更改");
  });

  it("falls back to English and then to the key", () => {
    expect(translate("fr" as LanguageCode, "app.welcome")).toBe(
      "Welcome to Logos",
    );
    expect(translate("zh", "missing.translation")).toBe(
      "missing.translation",
    );
  });
});
