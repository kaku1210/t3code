import { isReleaseBuild } from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import {
  useStartUpdateSession,
  useUpdateSessionStartingKind,
  type UpdateSessionKind,
} from "../../hooks/useStartUpdateSession";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { getUpdateCenterBridge, useDesktopUpdateCenter } from "../../state/desktopUpdateCenter";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function UpdateCenterSettings() {
  const state = useDesktopUpdateCenter();
  const { t } = useUiLanguage();
  const startUpdateSession = useStartUpdateSession();
  const startingKind = useUpdateSessionStartingKind();
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
  const startQuickUpdate = (kind: UpdateSessionKind) => {
    if (startingKind !== null) return;
    setError(null);
    void startUpdateSession(kind, state).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
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
      {isReleaseBuild(state.build) ? null : (
        <SettingsRow
          id="ai-quick-update"
          title={t("updates.aiQuickUpdateSettingsTitle")}
          description={t("updates.aiQuickUpdateSettingsDescription")}
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant={
                  state.upstream.status === "available" || state.upstream.status === "diverged"
                    ? "default"
                    : "outline"
                }
                disabled={
                  pending ||
                  startingKind !== null ||
                  state.installing ||
                  state.upstream.status === "checking"
                }
                onClick={() => startQuickUpdate("upstream")}
              >
                <SparklesIcon className="size-3" />
                {t(
                  startingKind === "upstream"
                    ? "updates.aiQuickUpdating"
                    : "updates.aiQuickUpdateUpstream",
                )}
              </Button>
              <Button
                size="xs"
                variant={
                  state.repository.status === "available" || state.repository.status === "diverged"
                    ? "default"
                    : "outline"
                }
                disabled={
                  pending ||
                  startingKind !== null ||
                  state.installing ||
                  state.repository.status === "checking"
                }
                onClick={() => startQuickUpdate("repository")}
              >
                <SparklesIcon className="size-3" />
                {t(
                  startingKind === "repository"
                    ? "updates.aiQuickUpdating"
                    : "updates.aiQuickUpdateRepository",
                )}
              </Button>
            </div>
          }
        />
      )}
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
                {state.preferences.sourcePath ?? t("updates.pathMissing")}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={pending || state.installing}
                onClick={() => act(() => getUpdateCenterBridge()!.chooseSource())}
              >
                {t(state.preferences.sourcePath ? "updates.change" : "updates.choose")}
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
