import { isProviderTextGenerationCapable } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Environment-specific controls for the background suggestion model. */
export function NextPromptSuggestionSettings() {
  const { t } = useUiLanguage();
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers = (
    (environmentId ? providersByEnvironment.get(environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS
  ).filter(isProviderTextGenerationCapable);
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const configured = settings.nextPromptSuggestionModelSelection;
  const selection = configured ?? resolveAppModelSelectionState(settings, providers);
  const active = entries.find((entry) => entry.instanceId === selection.instanceId);
  const hasModelChoice = entries.some((entry) => entry.enabled && entry.isAvailable);
  const mixedModel = useScopedSettingsMixed(["nextPromptSuggestionModelSelection"]);
  const disabledReason = useScopedModelDisabledReason(settings, entries);

  return (
    <SettingsSection id="next-prompt-suggestions" title={t("settings.promptSuggestion.title")}>
      <SettingsRow
        {...searchableSetting("next-prompt-suggestions-enabled")}
        serverScoped
        settingKeys={["nextPromptSuggestionsEnabled"]}
        description={t("settings.promptSuggestion.help")}
        control={
          <ScopedSwitch
            settingKeys={["nextPromptSuggestionsEnabled"]}
            checked={settings.nextPromptSuggestionsEnabled}
            aria-label={t("settings.promptSuggestion.enabled")}
            onCheckedChange={(checked) => updateSettings({ nextPromptSuggestionsEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("next-prompt-suggestions-model")}
        serverScoped
        settingKeys={["nextPromptSuggestionModelSelection"]}
        description={t("settings.promptSuggestion.modelHelp")}
        control={
          connectedEnvironments.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              {t("settings.voice.connectFirst")}
            </span>
          ) : !hasModelChoice ? (
            <span className="text-sm text-muted-foreground">{t("settings.voice.noProviders")}</span>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  selection.instanceId,
                  selection.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                {...(mixedModel
                  ? { triggerLabel: t("settings.promptSuggestion.mixed") }
                  : !configured
                    ? { triggerLabel: t("settings.promptSuggestion.chooseModel") }
                    : {})}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: t("settings.promptSuggestion.modelSaveError"),
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    nextPromptSuggestionModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
              {configured && active && active.enabled && active.isAvailable ? (
                <TraitsPicker
                  provider={active.driverKind}
                  models={active.models}
                  model={configured.model}
                  modelOptions={configured.options}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    updateSettings({
                      nextPromptSuggestionModelSelection: createModelSelection(
                        configured.instanceId,
                        configured.model,
                        options,
                      ),
                    })
                  }
                />
              ) : null}
            </div>
          )
        }
      />
    </SettingsSection>
  );
}
