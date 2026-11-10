import { createContext, useContext, useMemo } from "react";
import { translate, type MessageKey, type MessageValues } from "@t3tools/shared/i18n/messages";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";

import { translateMobileText } from "./messages";

export const UiLanguageContext = createContext<UiLanguage>("en");

/** Translates interface copy only, preserving agent output, code, project names and model IDs. */
export function useUiLanguage() {
  const language = useContext(UiLanguageContext);
  return useMemo(
    () => ({
      language,
      t: (key: MessageKey, values?: MessageValues) => translate(language, key, values),
      text: (source: string) => translateMobileText(language, source),
    }),
    [language],
  );
}
