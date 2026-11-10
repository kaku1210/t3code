import type { DesktopUpdateCenterState, DesktopUpdateSource } from "@t3tools/contracts";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { getUpdateCenterBridge, useDesktopUpdateCenter } from "../../state/desktopUpdateCenter";
import { Button } from "../ui/button";
import { keyReleaseNoteItems } from "../desktopUpdate.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const statusKeys = {
  idle: "updates.status.idle",
  checking: "updates.status.checking",
  current: "updates.status.current",
  available: "updates.status.available",
  ahead: "updates.status.ahead",
  diverged: "updates.status.diverged",
  error: "updates.status.error",
  unsupported: "updates.status.unsupported",
} as const;
const revision = (value: string | null) =>
  value && /^[a-f0-9]{40}$/i.test(value) ? value.slice(0, 12) : value;

function SourceRow({
  title,
  source,
  local,
  state,
  onInstall,
  onOpenUrl,
}: {
  title: string;
  source: DesktopUpdateSource;
  local?: boolean;
  state: DesktopUpdateCenterState;
  onInstall: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useUiLanguage();
  const showNotes = !["idle", "checking", "error", "unsupported"].includes(source.status);
  const releaseNotes = showNotes ? source.releaseNotes : undefined;
  const commits = showNotes ? source.commits : undefined;
  return (
    <section className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <span
          className={
            source.status === "available"
              ? "text-xs text-primary"
              : source.status === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
          }
        >
          {t(statusKeys[source.status])}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("updates.current")}</dt>
        <dd className="min-w-0 break-all font-mono">
          {revision(source.current) ?? t("updates.unknown")}
        </dd>
        <dt className="text-muted-foreground">{t("updates.latest")}</dt>
        <dd className="min-w-0 break-all font-mono">
          {revision(source.latest) ?? t("updates.unknown")}
        </dd>
      </dl>
      {source.majorUpdate ? (
        <p className="text-xs font-medium text-primary">{t("updates.major")}</p>
      ) : null}
      {source.message ? (
        <p className="text-xs break-words text-muted-foreground">{source.message}</p>
      ) : null}
      {source.checkedAt ? (
        <p className="text-2xs text-muted-foreground">
          {t("updates.checked")} · {new Date(source.checkedAt).toLocaleString()}
        </p>
      ) : null}
      {releaseNotes ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium">
            {t("updates.releaseNotes")}
          </summary>
          <div className="mt-2 max-h-64 space-y-2 overflow-y-auto text-xs">
            {releaseNotes.releasedAt ? (
              <p className="text-muted-foreground">
                {new Date(releaseNotes.releasedAt).toLocaleDateString()}
              </p>
            ) : null}
            {releaseNotes.intro ? <p>{releaseNotes.intro}</p> : null}
            {releaseNotes.stats ? (
              <p className="text-muted-foreground">{releaseNotes.stats}</p>
            ) : null}
            <ul className="list-disc space-y-1 pl-4">
              {keyReleaseNoteItems(releaseNotes.items).map(({ item, key }) => (
                <li key={key} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
            {releaseNotes.footer ? <p>{releaseNotes.footer}</p> : null}
            {releaseNotes.totalItems > releaseNotes.items.length ? (
              <p className="text-muted-foreground">{t("updates.moreChanges")}</p>
            ) : null}
          </div>
        </details>
      ) : null}
      {commits && commits.length > 0 ? (
        <details open={source.status === "available"}>
          <summary className="cursor-pointer text-xs font-medium">
            {t(source.status === "current" ? "updates.currentCommit" : "updates.commits")}
            {source.commitCount !== undefined ? (
              <span className="ml-2 text-muted-foreground">
                {commits.length}/{source.commitCount}
              </span>
            ) : null}
          </summary>
          <ul className="mt-2 ml-1 max-h-64 space-y-2 overflow-y-auto border-l border-border pl-3 text-xs">
            {commits.map((commit) => {
              const [subject, ...body] = commit.message.split("\n");
              return (
                <li key={commit.sha}>
                  <details>
                    <summary className="cursor-pointer break-words">
                      <span className="mr-2 font-mono text-muted-foreground">
                        {commit.sha.slice(0, 8)}
                      </span>
                      {subject}
                    </summary>
                    <div className="mt-2 ml-4 space-y-1">
                      {body.join("\n").trim() ? (
                        <p className="whitespace-pre-wrap break-words text-muted-foreground">
                          {body.join("\n").trim()}
                        </p>
                      ) : null}
                      <Button size="xs" variant="ghost" onClick={() => onOpenUrl(commit.url)}>
                        {t("updates.notes")}
                      </Button>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          {source.commitCount !== undefined && source.commitCount > commits.length ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("updates.moreChanges")}</p>
          ) : null}
        </details>
      ) : null}
      {!local && showNotes && !releaseNotes && !commits?.length ? (
        <p className="text-xs text-muted-foreground">{t("updates.noNotes")}</p>
      ) : null}
      {!local ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground">{t("updates.detectOnly")}</span>
          {source.url ? (
            <Button size="xs" variant="ghost" onClick={() => onOpenUrl(source.url!)}>
              {t("updates.notes")}
            </Button>
          ) : null}
        </div>
      ) : source.status === "available" ? (
        <Button size="sm" disabled={state.installing} onClick={onInstall}>
          {t(state.installing ? "updates.installing" : "updates.install")}
        </Button>
      ) : null}
    </section>
  );
}

export function DesktopUpdateCenter() {
  const state = useDesktopUpdateCenter();
  const { t } = useUiLanguage();
  const [error, setError] = useState<string | null>(null);
  const visible = Boolean(state?.supported && state.preferences.checkingEnabled);
  // Reserve the same title-bar width in chat, split panels and Settings.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the root DOM title-bar reservation aligned with the native update entry while mounted
  useEffect(() => {
    if (visible) document.documentElement.dataset.updateCenterVisible = "true";
    else delete document.documentElement.dataset.updateCenterVisible;
    return () => {
      delete document.documentElement.dataset.updateCenterVisible;
    };
  }, [visible]);
  if (!visible || !state) return null;
  const available = [
    state.upstream,
    state.repository,
    ...(state.localAllowed && state.preferences.quickUpdateEnabled ? [state.local] : []),
  ].some((source) => source.status === "available");
  const checking = [state.upstream, state.repository, state.local].some(
    (source) => source.status === "checking",
  );
  const act = (operation: () => Promise<unknown>) => {
    setError(null);
    void operation().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  const openUrl = (url: string) =>
    act(async () => {
      if (!(await window.desktopBridge!.openExternal(url)))
        throw new Error(t("updates.openFailed"));
    });
  return (
    <div className="[-webkit-app-region:no-drag] fixed top-(--workspace-controls-top) right-(--workspace-update-center-right) z-50 flex h-(--workspace-topbar-height) w-28 items-center justify-end">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant={available ? "secondary" : "ghost-muted"}
              aria-label={t("updates.title")}
            />
          }
        >
          <DownloadIcon className="size-3.5" />
          {t("updates.title")}
          {available ? <span className="size-1.5 rounded-full bg-primary" /> : null}
        </PopoverTrigger>
        <PopoverPopup width="lg" align="end" className="max-h-[min(80vh,44rem)] overflow-y-auto">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">{t("updates.title")}</h2>
            <Button
              size="xs"
              variant="ghost"
              disabled={checking || state.installing}
              onClick={() => act(() => getUpdateCenterBridge()!.check())}
            >
              <RefreshCwIcon className={checking ? "size-3 animate-spin" : "size-3"} />
              {t("updates.check")}
            </Button>
          </div>
          <p className="mt-1 text-xs break-all text-muted-foreground">
            {state.build.artifactVersion} · {state.build.sourceBranch ?? t("updates.unknown")} ·{" "}
            {revision(state.build.sourceRevision) ?? t("updates.unknown")}
          </p>
          {state.build.sourceDirty ? (
            <p className="mt-1 text-2xs text-muted-foreground">{t("updates.dirty")}</p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-xs break-words text-destructive">
              {error}
            </p>
          ) : null}
          <div className="divide-y divide-border">
            <SourceRow
              title={t("updates.upstream")}
              source={state.upstream}
              state={state}
              onInstall={() => {}}
              onOpenUrl={openUrl}
            />
            <SourceRow
              title={`${t("updates.repository")} · ${state.build.sourceBranch ?? "?"}`}
              source={state.repository}
              state={state}
              onInstall={() => {}}
              onOpenUrl={openUrl}
            />
            {state.localAllowed && state.preferences.quickUpdateEnabled ? (
              <SourceRow
                title={t("updates.local")}
                source={state.local}
                local
                state={state}
                onInstall={() => act(() => getUpdateCenterBridge()!.install())}
                onOpenUrl={openUrl}
              />
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
