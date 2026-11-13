import { isReleaseBuild, type DesktopUpdateSource } from "@t3tools/contracts";
import { DownloadIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  useStartUpdateSession,
  useUpdateSessionStartingKind,
  type UpdateSessionKind,
} from "../../hooks/useStartUpdateSession";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { getUpdateCenterBridge, useDesktopUpdateCenter } from "../../state/desktopUpdateCenter";
import { Button } from "../ui/button";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateInstallConfirmationMessage,
  keyReleaseNoteItems,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const statusKeys = {
  idle: "updates.status.idle",
  checking: "updates.status.checking",
  current: "updates.status.current",
  available: "updates.status.available",
  "needs-build": "updates.status.needsBuild",
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
  showEmptyNotes = true,
  actions,
  onOpenUrl,
}: {
  title: string;
  source: DesktopUpdateSource;
  showEmptyNotes?: boolean;
  actions?: ReactNode;
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
        <details>
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
      {showEmptyNotes && showNotes && !releaseNotes && !commits?.length ? (
        <p className="text-xs text-muted-foreground">{t("updates.noNotes")}</p>
      ) : null}
      {actions || source.url ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
          {source.url ? (
            <Button size="xs" variant="ghost" onClick={() => onOpenUrl(source.url!)}>
              {t("updates.notes")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Download and install go through the built-in updater, which reads the same published release. */
function ReleaseActions({
  source,
  disabled,
  onError,
}: {
  source: DesktopUpdateSource;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useUiLanguage();
  const updateState = useDesktopUpdateState();
  const [pending, setPending] = useState(false);
  if (source.status !== "available" || !updateState) return null;
  const blocked = getDesktopUpdateDisabledReason(updateState);
  if (blocked) return <p className="text-xs text-muted-foreground">{blocked}</p>;
  const action = resolveDesktopUpdateButtonAction(updateState);
  const run = (
    operation: () => Promise<Parameters<typeof getDesktopUpdateActionError>[0] | null>,
  ) => {
    setPending(true);
    void operation()
      .then((result) => {
        const message = result ? getDesktopUpdateActionError(result) : null;
        if (message) onError(message);
      })
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };
  if (updateState.status === "downloading")
    return (
      <Button size="sm" disabled>
        {t("updates.downloading")}
        {updateState.downloadPercent !== null ? ` ${Math.floor(updateState.downloadPercent)}%` : ""}
      </Button>
    );
  if (action === "install")
    return (
      <Button
        size="sm"
        disabled={disabled || pending}
        onClick={() =>
          run(async () => {
            const confirmed = await ensureLocalApi().dialogs.confirm(
              getDesktopUpdateInstallConfirmationMessage(updateState),
            );
            return confirmed
              ? window.desktopBridge!.installUpdate(updateState.downloadedVersion ?? undefined)
              : null;
          })
        }
      >
        {t("updates.install")}
      </Button>
    );
  return (
    <Button
      size="sm"
      disabled={disabled || pending || updateState.status === "checking"}
      onClick={() =>
        run(async () => {
          // A release published since the updater's last poll is not downloadable until it checks.
          if (action !== "download") await window.desktopBridge!.checkForUpdate();
          return window.desktopBridge!.downloadUpdate();
        })
      }
    >
      <DownloadIcon className="size-3" />
      {t("updates.download")}
    </Button>
  );
}

/** The title-bar update entry: an icon toggle that opens every update source. */
export function DesktopUpdateCenter() {
  const state = useDesktopUpdateCenter();
  const { t } = useUiLanguage();
  const startUpdateSession = useStartUpdateSession();
  const startingKind = useUpdateSessionStartingKind();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state?.supported || !state.preferences.checkingEnabled) return null;
  // main builds update from published releases; development builds follow source.
  const releaseBuild = isReleaseBuild(state.build);
  const localEnabled = state.localAllowed && state.preferences.quickUpdateEnabled;
  const sources = releaseBuild
    ? [state.release]
    : [state.upstream, state.repository, ...(localEnabled ? [state.local] : [])];
  const available = sources.some((source) => source.status === "available");
  const checking = sources.some((source) => source.status === "checking");
  const reportError = (message: string) => {
    setError(message);
    setOpen(true);
  };
  const act = (operation: () => Promise<unknown>) => {
    setError(null);
    void operation().catch((cause: unknown) =>
      reportError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  const openUrl = (url: string) =>
    act(async () => {
      if (!(await window.desktopBridge!.openExternal(url)))
        throw new Error(t("updates.openFailed"));
    });
  const startQuickUpdate = (kind: UpdateSessionKind) => {
    if (startingKind !== null) return;
    setError(null);
    void startUpdateSession(kind, state)
      .then((started) => {
        if (started) setOpen(false);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const aiSync = (kind: UpdateSessionKind, source: DesktopUpdateSource) => (
    <Button
      size="xs"
      variant={
        source.status === "available" || source.status === "diverged" ? "default" : "outline"
      }
      disabled={startingKind !== null || source.status === "checking" || state.installing}
      onClick={() => startQuickUpdate(kind)}
    >
      <SparklesIcon className="size-3" />
      {t(startingKind === kind ? "updates.aiQuickUpdating" : "updates.aiQuickUpdate")}
    </Button>
  );
  const label = t(state.installing ? "updates.installing" : "updates.title");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <PopoverTrigger
            render={
              <Toggle
                className="relative shrink-0 [-webkit-app-region:no-drag]"
                pressed={open}
                aria-label={t("updates.title")}
                variant="ghost"
                size="sm"
              />
            }
          >
            {state.installing ? (
              <RefreshCwIcon className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <DownloadIcon className="size-4" />
            )}
            {available ? (
              <span
                aria-hidden
                className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {available ? `${label} · ${t("updates.status.available")}` : label}
        </TooltipPopup>
      </Tooltip>
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
        {state.installing ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {t("updates.installProgress")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {error}
          </p>
        ) : null}
        {releaseBuild ? (
          <SourceRow
            title={t("updates.release")}
            source={state.release}
            actions={
              <ReleaseActions
                source={state.release}
                disabled={state.installing}
                onError={reportError}
              />
            }
            onOpenUrl={openUrl}
          />
        ) : (
          <>
            {localEnabled ? (
              <SourceRow
                title={t("updates.local")}
                source={state.local}
                showEmptyNotes={false}
                actions={
                  state.local.status === "available" ? (
                    <Button
                      size="sm"
                      disabled={state.installing}
                      onClick={() => act(() => getUpdateCenterBridge()!.install())}
                    >
                      {t(state.installing ? "updates.installing" : "updates.install")}
                    </Button>
                  ) : null
                }
                onOpenUrl={openUrl}
              />
            ) : null}
            <div className="mt-2 border-t border-border pt-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("updates.sourceSync")}
              </h3>
              <p className="mt-1 text-2xs text-muted-foreground">
                {t("updates.aiQuickUpdateHint")}
              </p>
              <div className="divide-y divide-border">
                <SourceRow
                  title={t("updates.upstream")}
                  source={state.upstream}
                  actions={aiSync("upstream", state.upstream)}
                  onOpenUrl={openUrl}
                />
                <SourceRow
                  title={`${t("updates.repository")} · ${state.build.sourceBranch ?? "?"}`}
                  source={state.repository}
                  actions={aiSync("repository", state.repository)}
                  onOpenUrl={openUrl}
                />
              </div>
            </div>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}
