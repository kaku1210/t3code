import { useEffect, useEffectEvent, useRef } from "react";

import { AppTextInput } from "../../../components/ui/AppText";
import { useUiLanguage } from "../../../i18n/useUiLanguage";
import { SettingsSection } from "./SettingsSection";

/** Edits device-local placeholder copy, committing on blur or when leaving the settings page. */
export function ComposerPlaceholderSettings(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { t, text } = useUiLanguage();
  const draft = useRef<{ readonly over: string; readonly text: string } | null>(null);
  const commit = () => {
    const pending = draft.current;
    draft.current = null;
    // A newer persisted value remounts the input and supersedes its older draft.
    if (pending === null || pending.over !== props.value) return;
    const value = pending.text.trim();
    if (value !== props.value) props.onChange(value);
  };
  const commitOnExit = useEffectEvent(commit);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android Back can leave this page without ending text editing; persist the remaining draft on exit.
  useEffect(() => () => commitOnExit(), []);

  return (
    <SettingsSection
      title={t("settings.chat.placeholder")}
      footer={t("settings.chat.placeholderHelp")}
    >
      <AppTextInput
        key={props.value}
        accessibilityLabel={t("settings.chat.placeholder")}
        defaultValue={props.value}
        placeholder={text("Ask anything")}
        editable={!props.disabled}
        autoCapitalize="sentences"
        className="min-h-12 px-4 py-3 font-sans text-base text-foreground"
        onChangeText={(value) => {
          draft.current = { over: props.value, text: value };
        }}
        onEndEditing={commit}
      />
    </SettingsSection>
  );
}
