import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_UI_LANGUAGE_PREFERENCE } from "@t3tools/contracts/settings";
import { resolveUiLanguage } from "@t3tools/shared/uiLanguage";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { UiLanguageContext } from "./useUiLanguage";

function systemLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function subscribeSystemLocale(refresh: () => void) {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh();
  });
  return () => subscription.remove();
}

/** Resolves this device's persisted language; foregrounding re-reads a changed system locale. */
export function UiLanguageProvider({ children }: { readonly children: ReactNode }) {
  const stored = useAtomValue(mobilePreferencesAtom);
  const preference = AsyncResult.isSuccess(stored)
    ? (stored.value.uiLanguage ?? DEFAULT_UI_LANGUAGE_PREFERENCE)
    : DEFAULT_UI_LANGUAGE_PREFERENCE;
  const locale = useSyncExternalStore(subscribeSystemLocale, systemLocale);
  return (
    <UiLanguageContext value={resolveUiLanguage(preference, locale)}>{children}</UiLanguageContext>
  );
}
