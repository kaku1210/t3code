import { UiLanguagePreference } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isUiLanguagePreference = Schema.is(UiLanguagePreference);

export function UiLanguageSetting() {
  const preference = useClientSettings((settings) => settings.uiLanguage);
  const { t } = useUiLanguage();
  const labels = {
    system: t("settings.followSystem"),
    en: "English",
    "zh-CN": "简体中文",
  };

  const changeLanguage = (value: unknown) => {
    if (!isUiLanguagePreference(value)) return;
    void persistClientSettingsUpdate((settings) => ({ ...settings, uiLanguage: value })).catch(
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("settings.languageSaveFailed"),
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    );
  };

  return (
    <SettingsRow
      {...searchableSetting("ui-language")}
      description={t("settings.languageDescription")}
      control={
        <Select value={preference} onValueChange={changeLanguage}>
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("settings.language")}>
            <SelectValue>{labels[preference]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="system">
              {labels.system}
            </SelectItem>
            <SelectItem hideIndicator value="en">
              {labels.en}
            </SelectItem>
            <SelectItem hideIndicator value="zh-CN">
              {labels["zh-CN"]}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
