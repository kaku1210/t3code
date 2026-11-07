import type { UiLanguagePreference } from "@t3tools/contracts/settings";

export type UiLanguage = Exclude<UiLanguagePreference, "system">;

export function resolveUiLanguage(
  preference: UiLanguagePreference,
  systemLocale: string | null | undefined,
): UiLanguage {
  if (preference !== "system") return preference;
  if (!systemLocale) return "en";

  try {
    const locale = new Intl.Locale(systemLocale);
    return locale.language === "zh" && locale.maximize().script === "Hans" ? "zh-CN" : "en";
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return "en";
  }
}
