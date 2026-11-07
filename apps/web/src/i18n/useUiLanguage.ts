import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import { createContext, useContext } from "react";

import { translate, type MessageKey, type MessageValues } from "./messages";

export const UiLanguageContext = createContext<UiLanguage>("en");

export function useUiLanguage() {
  const language = useContext(UiLanguageContext);
  return {
    language,
    t: (key: MessageKey, values?: MessageValues) => translate(language, key, values),
  };
}
