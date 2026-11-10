import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_UI_LANGUAGE_PREFERENCE,
  type UiLanguagePreference,
} from "@t3tools/contracts/settings";

import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { useUiLanguage } from "../../../../i18n/useUiLanguage";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";

const languages: readonly { readonly value: UiLanguagePreference; readonly label: string }[] = [
  { value: "system", label: "Follow system" },
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

/** Changes only this client's language through the existing optimistic, persisted preferences path. */
export function LanguageSection() {
  const { text } = useUiLanguage();
  const stored = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(stored) && !stored.waiting;
  const selected = AsyncResult.isSuccess(stored)
    ? (stored.value.uiLanguage ?? DEFAULT_UI_LANGUAGE_PREFERENCE)
    : DEFAULT_UI_LANGUAGE_PREFERENCE;
  return (
    <SettingsSection title={text("Interface language")}>
      {languages.map((entry, index) => (
        <ListChoiceRow
          key={entry.value}
          label={text(entry.label)}
          selected={entry.value === selected}
          separated={index > 0}
          disabled={!ready}
          onPress={() => update({ uiLanguage: entry.value })}
        />
      ))}
    </SettingsSection>
  );
}
