import { resolveUiLanguage } from "@t3tools/shared/uiLanguage";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { UiLanguageContext } from "./useUiLanguage";

function readSystemLocale(): string {
  return window.desktopBridge?.getSystemLocale?.() ?? navigator.language;
}

function subscribeToSystemLocale(refresh: () => void) {
  window.addEventListener("languagechange", refresh);
  window.addEventListener("focus", refresh);
  return () => {
    window.removeEventListener("languagechange", refresh);
    window.removeEventListener("focus", refresh);
  };
}

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  const preference = useClientSettings((settings) => settings.uiLanguage);
  const systemLocale = useSyncExternalStore(subscribeToSystemLocale, readSystemLocale);
  const language = resolveUiLanguage(preference, systemLocale);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- informs assistive technology of the current document language
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <UiLanguageContext value={language}>{children}</UiLanguageContext>;
}
