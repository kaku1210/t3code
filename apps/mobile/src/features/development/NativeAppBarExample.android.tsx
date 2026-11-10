import { useUiLanguage } from "../../i18n/useUiLanguage";
import { View } from "react-native";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/ui/IconButton";
import { NativeAppBar } from "../../components/ui/NativeAppBar.android";

export function NativeAppBarExample() {
  const { text: uiText } = useUiLanguage();
  return (
    <NativeAppBar
      title={<Text style={{ fontSize: 21 }}>{uiText("Native app bar")}</Text>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel="Example back" onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel="Example search"
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
