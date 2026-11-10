import type { ComponentProps } from "react";

import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { useUiLanguage } from "../../../i18n/useUiLanguage";

export function SettingsSwitchRow({
  subtitle,
  ...props
}: Omit<ComponentProps<typeof ListToggleRow>, "description"> & {
  readonly subtitle?: string;
}) {
  const { text } = useUiLanguage();
  return (
    <ListToggleRow
      {...props}
      label={text(props.label)}
      description={subtitle === undefined ? undefined : text(subtitle)}
    />
  );
}
