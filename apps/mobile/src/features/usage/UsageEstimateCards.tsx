import type { UsageEstimateSeries } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, G, Line, Text as SvgText } from "react-native-svg";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  buildUsageEstimateChart,
  collectUsageEstimateSeries,
  usageEstimateState,
  usageEstimateText,
  usageEstimateBlockerText,
  type EstimateResolution,
} from "@t3tools/shared/usageEstimates";
import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useProviderColors } from "./usageProviders";

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
  const color = useProviderColors().codex;
  const [resolution, setResolution] = useState<EstimateResolution>("day");
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [details, setDetails] = useState(false);
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
    <View className="gap-3 border-t border-border-subtle pt-4">
      <Text className="text-sm font-t3-medium text-foreground">
        {[
          label,
          series.source.scope?.providerLabel ?? "Codex",
          series.source.scope?.windowLabel,
          text.title,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <Text className="text-xs text-foreground-muted">{text[state]}</Text>
      <View className="gap-3">
        <Text className="text-sm font-t3-medium text-foreground">{text.history}</Text>
        <SegmentedControl
          options={[
            { value: "hour", label: text.hour },
            { value: "day", label: text.day },
          ]}
          selected={resolution}
          onSelect={(value: EstimateResolution) => {
            setResolution(value);
            setSelectedTime(null);
          }}
          size="compact"
        />
        {visiblePoints.length > 0 ? (
          <>
            <Text className="text-xs text-foreground-muted">USD · {formatUsd(chart.maxUsd)}</Text>
            <Svg viewBox="0 0 320 150" width="100%" height={150}>
              {[10, 75, 140].map((y) => (
                <Line key={y} x1={10} x2={310} y1={y} y2={y} stroke={color} opacity={0.1} />
              ))}
              {chart.points.map((point, index) => {
                const previous = chart.points[index - 1];
                if (point.y === null) return null;
                const x = 10 + point.x * 3;
                const y = 10 + point.y * 1.3;
                return (
                  <G key={point.sampledAtMs}>
                    {point.connected && previous?.y != null ? (
                      <Line
                        x1={10 + previous.x * 3}
                        y1={10 + previous.y * 1.3}
                        x2={x}
                        y2={y}
                        stroke={color}
                        strokeWidth={1.5}
                      />
                    ) : null}
                    <Circle
                      cx={x}
                      cy={y}
                      r={selected?.sampledAtMs === point.sampledAtMs ? 4 : 2.5}
                      fill={color}
                    />
                    {visiblePoints.length <= 5 || selected?.sampledAtMs === point.sampledAtMs ? (
                      <SvgText
                        x={x}
                        y={y < 25 ? y + 20 : y - 10}
                        textAnchor={x < 60 ? "start" : x > 260 ? "end" : "middle"}
                        fill={color}
                        fontSize={11}
                        fontWeight={selected?.sampledAtMs === point.sampledAtMs ? 600 : 400}
                      >
                        {formatUsd(point.cycleEquivalentUsd!)}
                      </SvgText>
                    ) : null}
                    <Circle
                      cx={x}
                      cy={y}
                      r={14}
                      fill="transparent"
                      accessibilityLabel={pointLabel(point)}
                      onPress={() => setSelectedTime(point.sampledAtMs)}
                    />
                  </G>
                );
              })}
            </Svg>
            <View className="flex-row justify-between gap-2">
              <Text className="text-xs text-foreground-muted">
                {date(chart.points[0]!.sampledAtMs)}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {date(chart.points.at(-1)!.sampledAtMs)}
              </Text>
            </View>
            <Text className="text-xs text-foreground-muted" accessibilityLiveRegion="polite">
              {selected ? pointLabel(selected) : ""}
            </Text>
          </>
        ) : (
          <Text className="py-4 text-xs text-foreground-muted">{text.noHistory}</Text>
        )}
        <Text className="text-xs text-foreground-muted">{text.historyHelp}</Text>
      </View>
      <View className="flex-row gap-4 border-t border-border-subtle pt-4">
        <View className="flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">{text.cycle}</Text>
          <Text className="text-2xl font-t3-semibold text-foreground">
            {hasValue && current?.cycleEquivalentUsd != null
              ? `≈ ${formatUsd(current.cycleEquivalentUsd)}`
              : "–"}
          </Text>
        </View>
        <View className="flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">{text.remaining}</Text>
          <Text className="text-2xl font-t3-semibold text-foreground">
            {hasValue && current?.remainingEquivalentUsd != null
              ? `≈ ${formatUsd(current.remainingEquivalentUsd)}`
              : "–"}
          </Text>
        </View>
      </View>
      {!hasValue ? <Text className="text-xs text-foreground-muted">{help}</Text> : null}
      {current?.models.some((model) => model.costUsd === null) ? (
        <Text className="text-xs text-foreground-muted">
          {text.missingPrices}:{" "}
          {current.models
            .filter((model) => model.costUsd === null)
            .map((model) => model.model)
            .join(", ")}
        </Text>
      ) : null}
      {current?.limitations.includes("free_models_excluded") ? (
        <Text className="text-xs text-foreground-muted">{text.freeRule}</Text>
      ) : null}
      {current?.limitations.includes("custom_prices") ? (
        <Text className="text-xs text-foreground-muted">{text.customRule}</Text>
      ) : null}
      {interval ? (
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted">
            {cycleToDate ? text.cycleRecorded : text.recorded}{" "}
            {current?.costUsd == null ? "–" : formatUsd(current.costUsd)} · {text.consumed}{" "}
            {interval.consumedPercent.toFixed(1)} {text.percentagePoints}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {cycleToDate ? text.cycleToDate : text.sample} · {date(interval.fromMs)} –{" "}
            {date(interval.untilMs)}
          </Text>
        </View>
      ) : null}
      <Text className="text-xs leading-relaxed text-foreground-muted">
        {series.source.coverage === "account"
          ? text.accountCaveat
          : cycleToDate
            ? text.cycleCaveat
            : text.caveat}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails(!details)}
        className="min-h-11 justify-center"
      >
        <Text className="text-xs text-foreground-muted">
          {text.details} {details ? "−" : "+"}
        </Text>
      </Pressable>
      {details ? (
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted" selectable>
            {text.device}: {series.source.deviceId} · {series.sourcePath}
          </Text>
          {current ? (
            <Text className="text-xs text-foreground-muted">
              {text.price}: {current.pricingId} · {text.records}: {current.records}
            </Text>
          ) : null}
          {current?.models.map((model) => (
            <Text key={model.model} className="text-xs text-foreground-muted">
              {model.model} · {model.records} ·{" "}
              {model.costUsd === null ? "–" : formatUsd(model.costUsd)}
              {model.quotaFreeRecords ? ` · ${model.quotaFreeRecords} ${text.freeRequests}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
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
    <View className="gap-4">
      {entries.map(({ label, series }) => (
        <EstimateCard key={series.source.id} series={series} label={label} now={now} />
      ))}
    </View>
  );
}
