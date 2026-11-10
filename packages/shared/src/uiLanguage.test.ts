import { describe, expect, it, vi } from "vite-plus/test";

import { resolveUiLanguage } from "./uiLanguage.ts";

describe("resolveUiLanguage", () => {
  it("uses the explicitly selected language regardless of the system language", () => {
    expect(resolveUiLanguage("en", "zh-CN")).toBe("en");
    expect(resolveUiLanguage("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("resolves the system language without Intl.Locale, as on Hermes", () => {
    vi.stubGlobal("Intl", Object.create(Intl, { Locale: { value: undefined } }));
    try {
      expect(resolveUiLanguage("system", "zh-CN")).toBe("zh-CN");
      expect(resolveUiLanguage("system", "zh-TW")).toBe("en");
      expect(resolveUiLanguage("system", "en-US")).toBe("en");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["zh", "zh-CN", "ZH-cn", "zh-SG", "zh-Hans-HK", "zh-Hans-TW", "zh-CN-u-ca-chinese"])(
    "uses Simplified Chinese for %s",
    (locale) => {
      expect(resolveUiLanguage("system", locale)).toBe("zh-CN");
    },
  );

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant-CN", "zh-Latn-CN", "fr-FR", "bad_locale", null])(
    "uses English for an unsupported or missing system locale (%s)",
    (locale) => {
      expect(resolveUiLanguage("system", locale)).toBe("en");
    },
  );
});
