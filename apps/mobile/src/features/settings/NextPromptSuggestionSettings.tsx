import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import {
  AuthSettingsWriteScope,
  type ServerSettingsPatch,
  isManagedSettingPath,
  isProviderAvailable,
  isProviderTextGenerationCapable,
} from "@t3tools/contracts";
import { createModelSelection, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { resolveMobileSettingsTargets } from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

/** Suggestion settings belong to their host environment, including its provider IDs and credentials. */
export function NextPromptSuggestionSettings() {
  const { text } = useUiLanguage();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  if (selectedTargets.length === 0)
    return (
      <SettingsSection title={text("Next step")}>
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {text("Connect an environment to configure next prompt suggestions.")}
        </Text>
      </SettingsSection>
    );
  return selectedTargets.map((target) => (
    <EnvironmentSuggestionSettings key={target.environmentId} target={target} />
  ));
}

function EnvironmentSuggestionSettings({ target }: { readonly target: SettingsTarget }) {
  const { t, text } = useUiLanguage();
  const canWrite = useEnvironmentScope(target.environmentId, AuthSettingsWriteScope);
  const write = useSettingsWriter();
  const [saving, setSaving] = useState(false);
  const config = target.serverConfig;
  const settings = config.settings;
  const configured = settings.nextPromptSuggestionModelSelection;
  const availableProviders = useAtomValue(
    serverEnvironment.providersValueAtom(target.environmentId),
  );
  const providers = (availableProviders ?? []).filter(
    (p) => p.enabled && isProviderAvailable(p) && isProviderTextGenerationCapable(p),
  );
  const options = buildModelOptions({ ...config, providers }, configured, undefined, null).filter(
    (o) => !o.isUnavailable && !o.isHidden,
  );
  const selected =
    configured === null
      ? undefined
      : options.find(
          (o) =>
            o.selection.instanceId === configured.instanceId &&
            o.selection.model === configured.model,
        );
  const enabledLocked = isManagedSettingPath(config.managedPolicy, "nextPromptSuggestionsEnabled");
  const modelLocked = isManagedSettingPath(
    config.managedPolicy,
    "nextPromptSuggestionModelSelection",
  );
  const disabled = !canWrite || saving;
  const reasoning = selected?.capabilities
    ? getProviderOptionDescriptors({
        caps: selected.capabilities,
        selections: configured?.options,
      }).find(isReasoningSelect)
    : undefined;
  const reasoningChoices = reasoning ? selectableProviderOptionChoices(reasoning) : [];

  const save = async (patch: ServerSettingsPatch) => {
    setSaving(true);
    await write(resolveMobileSettingsTargets([target], null), [
      { environmentId: target.environmentId, patch },
    ]).finally(() => setSaving(false));
  };

  return (
    <SettingsSection
      title={`${text("Next step")} · ${target.label}`}
      footer={t("settings.promptSuggestion.modelHelp")}
    >
      <SettingsSwitchRow
        label={t("settings.promptSuggestion.enabled")}
        subtitle={t("settings.promptSuggestion.help")}
        value={settings.nextPromptSuggestionsEnabled}
        disabled={disabled || enabledLocked}
        onValueChange={(value) => void save({ nextPromptSuggestionsEnabled: value })}
      />
      <View className="gap-3 px-4 py-3">
        <Menu
          accessibilityLabel={text("Choose model")}
          actions={groupByProvider(options).map((group) => ({
            id: group.providerKey,
            title: group.providerLabel,
            subactions: group.models.map((option) => ({
              id: option.key,
              title: option.label,
              state: option.key === selected?.key ? ("on" as const) : ("off" as const),
              attributes: { disabled: disabled || modelLocked },
            })),
          }))}
          onPressAction={({ nativeEvent }) => {
            const option = options.find((candidate) => candidate.key === nativeEvent.event);
            if (option) void save({ nextPromptSuggestionModelSelection: option.selection });
          }}
        >
          <View
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || modelLocked || options.length === 0 }}
            className="min-h-11 justify-center rounded-xl bg-subtle px-3"
          >
            <Text className="text-base text-foreground">
              {selected?.label ??
                text(
                  configured
                    ? "Suggestion model unavailable"
                    : options.length
                      ? "Choose model"
                      : "No available suggestion models",
                )}
            </Text>
          </View>
        </Menu>
        {configured && reasoning ? (
          <Menu
            accessibilityLabel={text("Reasoning effort")}
            actions={reasoningChoices.map((option) => ({
              id: option.id,
              title: text(option.label),
              state: option.id === reasoning.currentValue ? ("on" as const) : ("off" as const),
              attributes: { disabled: disabled || modelLocked },
            }))}
            onPressAction={({ nativeEvent }) => {
              const choice = reasoningChoices.find((option) => option.id === nativeEvent.event);
              if (choice)
                void save({
                  nextPromptSuggestionModelSelection: createModelSelection(
                    configured.instanceId,
                    configured.model,
                    [
                      ...(configured.options ?? []).filter((o) => o.id !== reasoning.id),
                      { id: reasoning.id, value: choice.id },
                    ],
                  ),
                });
            }}
          >
            <View
              accessibilityRole="button"
              accessibilityState={{ disabled: disabled || modelLocked }}
              className="min-h-11 justify-center rounded-xl bg-subtle px-3"
            >
              <Text className="text-base text-foreground">{`${text("Reasoning effort")} · ${text(reasoning.options.find((option) => option.id === reasoning.currentValue)?.label ?? "Default")}`}</Text>
            </View>
          </Menu>
        ) : null}
      </View>
    </SettingsSection>
  );
}
