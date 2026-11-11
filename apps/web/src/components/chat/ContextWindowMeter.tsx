import { Button } from "../ui/button";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ComposerControl } from "./ComposerControl";
import { useUiLanguage } from "~/i18n/useUiLanguage";

// oxlint-disable-next-line t3code/no-em-dash-copy -- Numeric missing-data marker, not punctuation in product prose.
const UNKNOWN_CONTEXT_VALUE = "—";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** Displays reported context usage; an unknown report or limit is distinct from zero usage. */
export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  loading?: boolean;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const { language, t } = useUiLanguage();
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : normalizedPercentage >= 70
      ? "var(--color-warning)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const fullTokens = (value: number | null | undefined) =>
    value == null ? UNKNOWN_CONTEXT_VALUE : value.toLocaleString(language);
  const displayedPercentage = usedPercentage ?? `${UNKNOWN_CONTEXT_VALUE}%`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <ComposerControl
            className="h-7 w-17 gap-1 px-1"
            data-testid="composer-context-window-control"
            aria-label={t("composer.contextWindowUsed", { percentage: displayedPercentage })}
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
            <span className="w-9 shrink-0 text-right text-xs tabular-nums">
              {displayedPercentage}
            </span>
          </ComposerControl>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">
              {t("composer.contextWindow")}
            </div>
            {usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {displayedPercentage}
              </div>
            )}
          </div>
          <p className="font-mono text-xs tabular-nums">
            {fullTokens(usage?.usedTokens)} / {fullTokens(usage?.maxTokens)} tokens
          </p>
          {modelDisplayName ? (
            <p className="text-secondary-label text-2xs">{modelDisplayName}</p>
          ) : null}
          {!usage || usedPercentage === null ? (
            <p className="text-secondary-label text-2xs">
              {t(
                props.loading
                  ? "composer.contextLoading"
                  : !usage
                    ? "composer.contextNotReported"
                    : "composer.contextLimitNotReported",
              )}
            </p>
          ) : null}
          {usedPercentage !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label={t("composer.contextWindow")}
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">{t("composer.contextTotalProcessed")}</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage?.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">{t("composer.contextCost")}</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage?.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {usage.autoCompactThreshold != null && usage.autoCompactThreshold > 0
                ? t("composer.contextAutoCompactThreshold", {
                    tokens: fullTokens(usage.autoCompactThreshold),
                  })
                : t("composer.contextAutoCompact")}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                {t("composer.contextCompact")}
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
