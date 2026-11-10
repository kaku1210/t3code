import { createContext, use, type ComponentProps } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ListSection } from "../../../components/ui/ListSection";
import { useUiLanguage } from "../../../i18n/useUiLanguage";

/**
 * Set while the Settings list is a split view's sidebar, naming the page open beside it. Like the
 * system Settings app, the sidebar lists plain rows and highlights that page instead of cards.
 */
export const SettingsSidebarContext = createContext<{ readonly selected: string | null } | null>(
  null,
);

export function SettingsSection(props: ComponentProps<typeof ListSection>) {
  const { text } = useUiLanguage();
  const title = props.title === undefined ? undefined : text(props.title);
  const footer = props.footer === undefined ? undefined : text(props.footer);
  if (!use(SettingsSidebarContext)) return <ListSection {...props} title={title} footer={footer} />;
  return (
    <View className="gap-1">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3 px-2">
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            {props.titleIcon}
            <Text textRole="footnote" className="shrink font-t3-medium text-foreground-muted">
              {title}
            </Text>
          </View>
          {props.trailing}
        </View>
      ) : null}
      <View>{props.children}</View>
      {props.footer ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {footer}
        </Text>
      ) : null}
    </View>
  );
}
