import { useState } from "react";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { getUpdateCenterBridge, useDesktopUpdateCenter } from "../../state/desktopUpdateCenter";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function UpdateCenterSettings() {
  const state = useDesktopUpdateCenter();
  const { t } = useUiLanguage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state?.supported) return null;
  const act = (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    void operation()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };
  return (
    <>
      <SettingsRow
        {...searchableSetting("check-updates")}
        title={t("updates.enabled")}
        description={t("updates.enabledDescription")}
        control={
          <Switch
            aria-label={t("updates.enabled")}
            checked={state.preferences.checkingEnabled}
            disabled={pending || state.installing}
            onCheckedChange={(checkingEnabled) =>
              act(() => getUpdateCenterBridge()!.configure({ checkingEnabled }))
            }
          />
        }
      />
      {state.localAllowed ? (
        <SettingsRow
          id="quick-local-update"
          title={t("updates.quick")}
          description={t("updates.quickDescription")}
          control={
            <Switch
              aria-label={t("updates.quick")}
              checked={state.preferences.quickUpdateEnabled}
              disabled={pending || state.installing}
              onCheckedChange={(quickUpdateEnabled) =>
                act(() => getUpdateCenterBridge()!.configure({ quickUpdateEnabled }))
              }
            />
          }
        >
          {state.preferences.quickUpdateEnabled ? (
            <div className="mt-2 flex items-start justify-between gap-3">
              <p className="min-w-0 break-all text-xs text-muted-foreground">
                {state.preferences.commandPath ?? t("updates.pathMissing")}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={pending || state.installing}
                onClick={() => act(() => getUpdateCenterBridge()!.chooseCommand())}
              >
                {t(state.preferences.commandPath ? "updates.change" : "updates.choose")}
              </Button>
            </div>
          ) : null}
        </SettingsRow>
      ) : null}
      {error ? (
        <p role="alert" className="py-2 text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
