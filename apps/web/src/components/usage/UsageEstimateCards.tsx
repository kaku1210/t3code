import type { UsageEstimateSeries } from "@t3tools/contracts";
import { useState } from "react";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  buildUsageEstimateChart,
  collectUsageEstimateSeries,
  usageEstimateState,
  usageEstimateText,
  usageEstimateBlockerText,
  type EstimateResolution,
} from "@t3tools/shared/usageEstimates";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Button } from "../ui/button";

function EstimateCard({
  series,
  label,
  now,
}: {
  series: UsageEstimateSeries;
  label: string;
  now: number;
}) {
  const { language } = useUiLanguage();
  const text = usageEstimateText(language);
  const [resolution, setResolution] = useState<EstimateResolution>("day");
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const state = usageEstimateState(series, now);
  const current = series.current?.result;
  const cycleToDate = current?.basis === "cycle_to_date";
  const interval = current?.interval;
  const hasValue = state === "estimated" || state === "reference_only";
  const chart = buildUsageEstimateChart(series.history, resolution);
  const visiblePoints = chart.points.filter((point) => point.y !== null);
  const selected =
    visiblePoints.find((point) => point.sampledAtMs === selectedTime) ?? visiblePoints.at(-1);
  const date = (time: number) =>
    new Date(time).toLocaleString(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const pointLabel = (point: (typeof chart.points)[number]) =>
    `${date(point.sampledAtMs)} · ${formatUsd(point.cycleEquivalentUsd ?? 0)} · ${point.basis === "cycle_to_date" ? text.cycleRecorded : text.recorded} ${formatUsd(point.costUsd ?? 0)} / ${point.consumedPercent ?? 0} ${text.percentagePoints}`;
  const help =
    state === "expired"
      ? text.expiredHelp
      : state === "pricing_unavailable"
        ? text.pricingHelp
        : state === "blocked"
          ? usageEstimateBlockerText(current?.blockers ?? [], language)
          : cycleToDate
            ? text.cycleCollectingHelp
            : series.source.scope
              ? text.intervalCollectingHelp
              : text.collectingHelp;
  return (
    <article className="border-t border-border/60 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {[
            label,
            series.source.scope?.providerLabel ?? "Codex",
            series.source.scope?.windowLabel,
            text.title,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span>{text[state]}</span>
      </div>
      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium">{text.history}</h3>
          <div className="flex gap-1" role="group" aria-label={text.history}>
            {(["hour", "day"] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={resolution === value ? "secondary" : "ghost"}
                aria-pressed={resolution === value}
                onClick={() => {
                  setResolution(value);
                  setSelectedTime(null);
                }}
              >
                {text[value]}
              </Button>
            ))}
          </div>
        </div>
        {visiblePoints.length > 0 ? (
          <>
            <div className="mt-3 flex justify-between text-3xs text-muted-foreground">
              <span>USD</span>
              <span>{formatUsd(chart.maxUsd)}</span>
            </div>
            <svg
              viewBox="0 0 620 156"
              className="mt-1 h-40 w-full overflow-visible text-foreground"
              aria-label={text.history}
              role="group"
            >
              {[16, 78, 140].map((y) => (
                <line key={y} x1="10" x2="610" y1={y} y2={y} stroke="currentColor" opacity="0.09" />
              ))}
              {chart.points.map((point, index) => {
                const previous = chart.points[index - 1];
                if (point.y === null) return null;
                const x = 10 + point.x * 6;
                const y = 16 + point.y * 1.24;
                return (
                  <g key={point.sampledAtMs}>
                    {point.connected && previous?.y != null ? (
                      <line
                        x1={10 + previous.x * 6}
                        y1={16 + previous.y * 1.24}
                        x2={x}
                        y2={y}
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    ) : null}
                    <circle
                      cx={x}
                      cy={y}
                      r={selected?.sampledAtMs === point.sampledAtMs ? 4 : 2.5}
                      fill="currentColor"
                    />
                    {visiblePoints.length <= 8 || selected?.sampledAtMs === point.sampledAtMs ? (
                      <text
                        x={x}
                        y={y < 30 ? y + 20 : y - 10}
                        textAnchor={x < 70 ? "start" : x > 550 ? "end" : "middle"}
                        fill="currentColor"
                        fontSize="11"
                        fontWeight={selected?.sampledAtMs === point.sampledAtMs ? 600 : 400}
                        aria-hidden="true"
                      >
                        {formatUsd(point.cycleEquivalentUsd!)}
                      </text>
                    ) : null}
                    <circle
                      cx={x}
                      cy={y}
                      r="8"
                      fill="transparent"
                      tabIndex={0}
                      role="button"
                      aria-label={pointLabel(point)}
                      onFocus={() => setSelectedTime(point.sampledAtMs)}
                      onMouseEnter={() => setSelectedTime(point.sampledAtMs)}
                      onClick={() => setSelectedTime(point.sampledAtMs)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedTime(point.sampledAtMs);
                        }
                      }}
                    >
                      <title>{pointLabel(point)}</title>
                    </circle>
                  </g>
                );
              })}
            </svg>
            <div className="flex justify-between text-3xs text-muted-foreground">
              <span>{date(chart.points[0]!.sampledAtMs)}</span>
              <span>{date(chart.points.at(-1)!.sampledAtMs)}</span>
            </div>
            <p
              className="mt-2 min-h-4 text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {selected ? pointLabel(selected) : null}
            </p>
          </>
        ) : (
          <p className="py-6 text-xs text-muted-foreground">{text.noHistory}</p>
        )}
        <p className="mt-2 text-2xs text-muted-foreground">{text.historyHelp}</p>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border/60 pt-4">
        <div>
          <p className="text-xs text-muted-foreground">{text.cycle}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {hasValue &&
            current?.cycleEquivalentUsd !== null &&
            current?.cycleEquivalentUsd !== undefined
              ? `≈ ${formatUsd(current.cycleEquivalentUsd)}`
              : "–"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{text.remaining}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {hasValue &&
            current?.remainingEquivalentUsd !== null &&
            current?.remainingEquivalentUsd !== undefined
              ? `≈ ${formatUsd(current.remainingEquivalentUsd)}`
              : "–"}
          </p>
        </div>
      </div>
      {!hasValue ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {help}
        </p>
      ) : null}
      {current?.models.some((model) => model.costUsd === null) ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {text.missingPrices}:{" "}
          {current.models
            .filter((model) => model.costUsd === null)
            .map((model) => model.model)
            .join(", ")}
        </p>
      ) : null}
      {current?.limitations.includes("free_models_excluded") ? (
        <p className="mt-2 text-xs text-muted-foreground">{text.freeRule}</p>
      ) : null}
      {current?.limitations.includes("custom_prices") ? (
        <p className="mt-2 text-xs text-muted-foreground">{text.customRule}</p>
      ) : null}
      {interval ? (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>
            {cycleToDate ? text.cycleRecorded : text.recorded}{" "}
            {current?.costUsd == null ? "–" : formatUsd(current.costUsd)} · {text.consumed}{" "}
            {interval.consumedPercent.toFixed(1)} {text.percentagePoints}
          </p>
          <p>
            {cycleToDate ? text.cycleToDate : text.sample} · {date(interval.fromMs)} –{" "}
            {date(interval.untilMs)}
          </p>
        </div>
      ) : null}
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        {series.source.coverage === "account"
          ? text.accountCaveat
          : cycleToDate
            ? text.cycleCaveat
            : text.caveat}
      </p>
      <details className="mt-4 text-xs text-muted-foreground">
        <summary className="cursor-pointer">{text.details}</summary>
        <div className="mt-2 space-y-1 break-all">
          <p>
            {text.device}: {series.source.deviceId} · {series.sourcePath}
          </p>
          {current ? (
            <p>
              {text.price}: {current.pricingId} · {text.records}: {current.records}
            </p>
          ) : null}
          {current?.models.map((model) => (
            <p key={model.model}>
              {model.model} · {model.records} ·{" "}
              {model.costUsd === null ? "–" : formatUsd(model.costUsd)}
              {model.quotaFreeRecords ? ` · ${model.quotaFreeRecords} ${text.freeRequests}` : ""}
            </p>
          ))}
        </div>
      </details>
    </article>
  );
}

export function UsageEstimateCards({
  entries,
  now,
}: {
  entries: ReturnType<typeof collectUsageEstimateSeries>;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      {entries.map(({ label, series }) => (
        <EstimateCard key={series.source.id} series={series} label={label} now={now} />
      ))}
    </div>
  );
}
