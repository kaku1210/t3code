import { describe, expect, it } from "vite-plus/test";

import { resolveUiLanguage } from "./uiLanguage.ts";

describe("resolveUiLanguage", () => {
  it("uses the explicitly selected language regardless of the system language", () => {
    expect(resolveUiLanguage("en", "zh-CN")).toBe("en");
    expect(resolveUiLanguage("zh-CN", "en-US")).toBe("zh-CN");
  });

  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans-HK"])("uses Simplified Chinese for %s", (locale) => {
    expect(resolveUiLanguage("system", locale)).toBe("zh-CN");
  });

  it.each(["zh-TW", "zh-Hant-CN", "fr-FR", "bad_locale", null])(
    "uses English for an unsupported or missing system locale (%s)",
    (locale) => {
      expect(resolveUiLanguage("system", locale)).toBe("en");
    },
  );
});
