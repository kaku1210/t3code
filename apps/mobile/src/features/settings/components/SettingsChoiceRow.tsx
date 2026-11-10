import type { ComponentProps } from "react";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { useUiLanguage } from "../../../i18n/useUiLanguage";

/** Localizes settings-owned choice labels; selection IDs and persisted values stay unchanged. */
export function SettingsChoiceRow(props: ComponentProps<typeof ListChoiceRow>) {
  const { text } = useUiLanguage();
  return (
    <ListChoiceRow
      {...props}
      label={text(props.label)}
      description={props.description === undefined ? undefined : text(props.description)}
    />
  );
}
