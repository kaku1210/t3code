import type { UiLanguagePreference } from "@t3tools/contracts/settings";

export type UiLanguage = Exclude<UiLanguagePreference, "system">;

/** Resolves the two supported UI languages using locale APIs also available in Hermes. */
export function resolveUiLanguage(
  preference: UiLanguagePreference,
  systemLocale: string | null | undefined,
): UiLanguage {
  if (preference !== "system") return preference;
  if (!systemLocale) return "en";

  try {
    // A non-empty locale string canonicalizes to one tag; Hermes does not expose Intl.Locale.
    const [language, scriptOrRegion] = Intl.getCanonicalLocales(systemLocale)[0]!.split("-");
    if (language !== "zh") return "en";
    if (scriptOrRegion && /^[A-Z][a-z]{3}$/.test(scriptOrRegion)) {
      return scriptOrRegion === "Hans" ? "zh-CN" : "en";
    }
    // Without an explicit script, these Chinese regions use Traditional Chinese.
    return scriptOrRegion === "TW" || scriptOrRegion === "HK" || scriptOrRegion === "MO"
      ? "en"
      : "zh-CN";
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return "en";
  }
}
