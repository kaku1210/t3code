import {
  UsageTokenTotals,
  type EstimateSource,
  type UsageIntervalEstimate,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { USAGE_ESTIMATE_RESET_TOLERANCE_MS } from "@t3tools/shared/usageEstimates";

import { priceUsage, type ModelRate, type RateTable } from "./usagePricing.ts";

const Id = Schema.String.check(Schema.isMinLength(1));
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Price = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const TokenRates = Schema.Struct({
  inputCostPerToken: Price,
  outputCostPerToken: Price,
  cacheReadCostPerToken: Price,
  cacheCreationCostPerToken: Price,
});
const ModelRateSchema = Schema.Struct({
  ...TokenRates.fields,
  fast: Schema.NullOr(TokenRates),
  ultrafast: Schema.NullOr(TokenRates),
  introductory: Schema.optionalKey(
    Schema.Struct({ ...TokenRates.fields, untilMs: Timestamp, fast: Schema.NullOr(TokenRates) }),
  ),
  quotaFree: Schema.optionalKey(
    Schema.Struct({ provider: Id, plans: Schema.Array(Id), untilMs: Timestamp }),
  ),
});

const EventFields = { id: Id, timestampMs: Timestamp, sessionId: Id };
export const EstimateEvent = Schema.Union([
  Schema.Struct({
    ...EventFields,
    kind: Schema.Literal("usage"),
    model: Id,
    rateModel: Schema.optionalKey(Id),
    totals: UsageTokenTotals,
    speed: Schema.Literals(["standard", "fast", "ultrafast"]),
    speedKnown: Schema.Boolean,
  }),
  Schema.Struct({
    ...EventFields,
    kind: Schema.Literal("quota"),
    usedPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    windowMinutes: Timestamp,
    resetsAtMs: Timestamp,
    limitId: Id,
    plan: Schema.NullOr(Id),
    origin: Schema.Literals(["session_cache", "account_probe"]),
    startsAtMs: Schema.optionalKey(Timestamp),
  }),
  Schema.Struct({
    ...EventFields,
    kind: Schema.Literal("issue"),
    reason: Schema.Literals(["malformed_usage", "malformed_quota", "unsupported_provider"]),
  }),
]);
export type EstimateEvent = typeof EstimateEvent.Type;

/** Exact rates are stored locally, so later price refreshes cannot rewrite an old estimate. */
export const EstimatePricing = Schema.Struct({
  id: Id,
  description: Id,
  rates: Schema.Record(Schema.String, ModelRateSchema),
  overrides: Schema.optionalKey(Schema.Record(Schema.String, ModelRateSchema)),
});
export type EstimatePricing = typeof EstimatePricing.Type;

/** Explicit replay bounds use (first quota, last quota]; cached observations imply no settlement guarantee. */
export function estimateUsageInterval(
  source: EstimateSource,
  events: readonly EstimateEvent[],
  pricing: EstimatePricing,
  bounds: { readonly fromMs: number; readonly untilMs: number },
): UsageIntervalEstimate {
  return estimateUsage(source, events, pricing, bounds, "interval");
}

/** Price this device's cycle-to-date records against total consumed quota, assuming local coverage. */
export function estimateUsageCycle(
  source: EstimateSource,
  events: readonly EstimateEvent[],
  pricing: EstimatePricing,
  bounds: { readonly fromMs: number; readonly untilMs: number; readonly resetsAtMs: number },
): UsageIntervalEstimate {
  return estimateUsage(source, events, pricing, bounds, "cycle_to_date");
}

/** Share price validation while keeping continuous-interval and cycle-to-date boundaries explicit. */
function estimateUsage(
  source: EstimateSource,
  events: readonly EstimateEvent[],
  pricing: EstimatePricing,
  bounds: { readonly fromMs: number; readonly untilMs: number; readonly resetsAtMs?: number },
  basis: "interval" | "cycle_to_date",
): UsageIntervalEstimate {
  const cycleToDate = basis === "cycle_to_date";
  const ordered = events
    .filter((event) => event.timestampMs >= bounds.fromMs && event.timestampMs <= bounds.untilMs)
    .toSorted((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
  const quotas = ordered.filter(
    (event): event is Extract<EstimateEvent, { kind: "quota" }> =>
      event.kind === "quota" && matchesEstimateWindow(event, source),
  );
  const first = quotas[0];
  const last = quotas.at(-1);
  const knownPlan = quotas.find((quota) => quota.plan !== null)?.plan;
  const blockers = new Set<string>();
  const limitations = [
    source.coverage === "account" ? "account_history" : "source_device_records_only",
    "usage_mix_dependent",
  ];
  if (cycleToDate) limitations.push("assumes_local_cycle_coverage");
  if (source.accountId === null) limitations.push("account_unconfirmed");
  if (source.coverage === "selected_sessions") limitations.push("selected_sessions_only");
  if (!cycleToDate && source.scope) limitations.push("cycle_start_unknown");
  if (last?.resetsAtMs === 0) blockers.add("reset_unknown");
  if (quotas.some((quota) => quota.origin === "session_cache"))
    limitations.push("quota_may_be_cached");

  let previous = first;
  for (const quota of quotas) {
    if (
      first &&
      ((cycleToDate
        ? Math.abs(quota.resetsAtMs - first.resetsAtMs) > USAGE_ESTIMATE_RESET_TOLERANCE_MS
        : quota.resetsAtMs !== first.resetsAtMs) ||
        quota.windowMinutes !== first.windowMinutes ||
        (quota.plan !== null && quota.plan !== knownPlan))
    ) {
      blockers.add("cycle_or_plan_changed");
    }
    if (
      previous &&
      quota.usedPercent < previous.usedPercent &&
      (!cycleToDate || quota.origin !== "session_cache")
    )
      blockers.add("quota_regressed");
    previous = quota;
  }
  const usableEndpoints =
    first !== undefined &&
    last !== undefined &&
    last.resetsAtMs > 0 &&
    (cycleToDate || last.timestampMs > first.timestampMs);
  const selected = usableEndpoints
    ? ordered.filter(
        (event) =>
          (cycleToDate
            ? event.timestampMs >= bounds.fromMs
            : event.timestampMs > first.timestampMs) && event.timestampMs <= last.timestampMs,
      )
    : [];
  const rates: RateTable = new Map<string, ModelRate>(Object.entries(pricing.rates));
  const overrides: RateTable = new Map(Object.entries(pricing.overrides ?? {}));
  const models = new Map<
    string,
    { model: string; records: number; costUsd: number | null; quotaFreeRecords?: number }
  >();
  let costUsd = 0;
  let records = 0;
  for (const event of selected) {
    if (event.kind === "issue") blockers.add(event.reason);
    if (event.kind !== "usage") continue;
    records++;
    const model: {
      model: string;
      records: number;
      costUsd: number | null;
      quotaFreeRecords?: number;
    } = models.get(event.model) ?? { model: event.model, records: 0, costUsd: 0 };
    model.records++;
    const priced = priceUsage(
      rates,
      {
        ...event,
        provider: source.scope?.provider ?? "codex",
        reportedCostUsd: null,
      },
      overrides,
      knownPlan,
    );
    if (priced.quotaFree) {
      model.quotaFreeRecords = (model.quotaFreeRecords ?? 0) + 1;
      if (!limitations.includes("free_models_excluded")) limitations.push("free_models_excluded");
    }
    if (overrides.has(event.model.trim()) && !limitations.includes("custom_prices"))
      limitations.push("custom_prices");
    if (priced.costSource === "unpriced") {
      blockers.add("unpriced_usage");
      model.costUsd = null;
    } else if (!event.speedKnown) {
      blockers.add("speed_unconfirmed");
      model.costUsd = null;
    } else {
      costUsd += priced.costUsd;
      if (model.costUsd !== null) model.costUsd += priced.costUsd;
    }
    models.set(event.model, model);
  }
  const interval = usableEndpoints
    ? {
        fromMs: cycleToDate ? bounds.fromMs : first.timestampMs,
        untilMs: last.timestampMs,
        startUsedPercent: cycleToDate ? 0 : first.usedPercent,
        endUsedPercent: last.usedPercent,
        resetsAtMs: cycleToDate ? bounds.resetsAtMs! : last.resetsAtMs,
        consumedPercent: cycleToDate ? last.usedPercent : last.usedPercent - first.usedPercent,
      }
    : null;
  if (
    interval &&
    (interval.fromMs >= interval.resetsAtMs || interval.untilMs >= interval.resetsAtMs)
  )
    blockers.add("expired_quota_observation");
  if (
    interval &&
    interval.consumedPercent > 0 &&
    records > 0 &&
    [...models.values()].reduce((count, model) => count + (model.quotaFreeRecords ?? 0), 0) ===
      records
  )
    blockers.add("quota_without_paid_usage");
  // Five percentage points is an initial display threshold, not a confidence or error bound.
  const enough = interval !== null && interval.consumedPercent >= 5 && records > 0;
  const referenceOnly =
    cycleToDate ||
    source.accountId === null ||
    source.coverage === "selected_sessions" ||
    quotas.some((quota) => quota.origin === "session_cache");
  const status =
    blockers.size > 0
      ? "blocked"
      : !enough
        ? "collecting"
        : referenceOnly
          ? "reference_only"
          : "estimated";
  const cycleEquivalentUsd =
    (status === "estimated" || status === "reference_only") && interval
      ? (costUsd * 100) / interval.consumedPercent
      : null;
  return {
    ...(cycleToDate ? { basis } : {}),
    status,
    source,
    pricingId: pricing.id,
    blockers: [...blockers],
    limitations,
    interval,
    records,
    costUsd:
      !usableEndpoints ||
      ["unpriced_usage", "speed_unconfirmed", "malformed_usage", "unsupported_provider"].some(
        (reason) => blockers.has(reason),
      )
        ? null
        : costUsd,
    cycleEquivalentUsd,
    remainingEquivalentUsd:
      cycleEquivalentUsd !== null && interval
        ? (cycleEquivalentUsd * (100 - interval.endUsedPercent)) / 100
        : null,
    models: [...models.values()],
  };
}

function matchesEstimateWindow(
  event: Extract<EstimateEvent, { kind: "quota" }>,
  source?: EstimateSource,
) {
  return source?.scope
    ? event.limitId === source.scope.windowId
    : event.limitId === "codex" && event.windowMinutes >= 10080 && event.windowMinutes < 43200;
}

/** Probe samples are settled observations; cached session ticks only sample rising quota values. */
export function selectUsageEstimateCycleSamples(
  events: readonly EstimateEvent[],
  source?: EstimateSource,
) {
  const quotas = events
    .filter(
      (event): event is Extract<EstimateEvent, { kind: "quota" }> =>
        event.kind === "quota" && matchesEstimateWindow(event, source),
    )
    .toSorted((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
  const latest = quotas.at(-1);
  if (!latest) return [];
  const cycleStart =
    latest.startsAtMs ??
    (latest.windowMinutes > 0
      ? Math.max(0, latest.resetsAtMs - latest.windowMinutes * 60_000)
      : undefined);
  const cycleQuotas = quotas.filter(
    (quota) =>
      quota.plan === latest.plan &&
      quota.windowMinutes === latest.windowMinutes &&
      Math.abs(quota.resetsAtMs - latest.resetsAtMs) <= USAGE_ESTIMATE_RESET_TOLERANCE_MS &&
      quota.timestampMs >= (cycleStart ?? 0),
  );
  const fromMs = cycleStart ?? cycleQuotas[0]!.timestampMs;
  let highest = -1;
  return cycleQuotas.flatMap((quota) => {
    if (
      quota.timestampMs < fromMs ||
      quota.plan !== latest.plan ||
      quota.windowMinutes !== latest.windowMinutes ||
      Math.abs(quota.resetsAtMs - latest.resetsAtMs) > USAGE_ESTIMATE_RESET_TOLERANCE_MS ||
      (quota.usedPercent <= highest && (!source?.scope || quota.origin === "session_cache"))
    )
      return [];
    highest = Math.max(highest, quota.usedPercent);
    return [
      {
        key: quota.id,
        basis: cycleStart === undefined ? ("interval" as const) : ("cycle_to_date" as const),
        fromMs,
        untilMs: quota.timestampMs,
        resetsAtMs: latest.resetsAtMs,
        segmentStartMs: fromMs,
      },
    ];
  });
}
