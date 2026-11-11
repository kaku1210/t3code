import type { PromptSuggestionState } from "@t3tools/client-runtime/state/prompt-suggestions";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useUiLanguage } from "../../i18n/useUiLanguage";

/** Presents a host-generated suggestion and its retry state without starting local model work. */
export function PromptSuggestionControl({
  state,
  onUse,
  onRegenerate,
}: {
  readonly state: PromptSuggestionState;
  readonly onUse: (suggestion: string) => void;
  readonly onRegenerate: (() => void) | null;
}) {
  const { t, text } = useUiLanguage();
  if (state.status === "unavailable") return null;
  return (
    <View className="mb-2 gap-2">
      {state.status === "ready" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${text("Use suggestion")}: ${state.suggestion}`}
          className="min-h-11 rounded-xl border border-border-subtle px-4 py-3 active:opacity-70"
          onPress={() => onUse(state.suggestion)}
        >
          <Text className="text-xs text-foreground-muted">{text("Next step")}</Text>
          <Text className="text-sm text-foreground" numberOfLines={3}>
            {state.suggestion}
          </Text>
        </Pressable>
      ) : state.status === "generating" ? (
        <View className="flex-row items-center gap-2 px-2" accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" />
          <Text className="text-xs text-foreground-muted">
            {t("composer.promptSuggestionGenerating")}
          </Text>
        </View>
      ) : (
        <View className="gap-1 px-2" accessibilityLiveRegion="polite">
          <Text className="text-xs text-foreground-muted">
            {state.status === "failed"
              ? t(
                  state.retryable
                    ? "composer.promptSuggestionFailed"
                    : "composer.promptSuggestionBlocked",
                )
              : t(
                  state.reason
                    ? `composer.promptSuggestionEmpty.${state.reason}`
                    : "composer.promptSuggestionEmpty",
                )}
          </Text>
          {state.status === "failed" && state.detail ? (
            <Text className="text-xs text-foreground-muted">{state.detail}</Text>
          ) : null}
        </View>
      )}
      {onRegenerate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            state.status === "ready"
              ? "composer.promptSuggestionRegenerate"
              : "composer.promptSuggestionRetryAction",
          )}
          className="min-h-11 justify-center self-start px-2 active:opacity-70"
          onPress={onRegenerate}
        >
          <Text className="text-xs text-foreground-muted">
            {t(
              state.status === "ready"
                ? "composer.promptSuggestionRegenerate"
                : "composer.promptSuggestionRetry",
            )}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
