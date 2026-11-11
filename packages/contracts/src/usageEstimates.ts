import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1));
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Price = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const EstimateSource = Schema.Struct({
  id: Id,
  deviceId: Id,
  accountId: Schema.NullOr(Id),
  coverage: Schema.Literals(["device", "selected_sessions", "account"]),
  /** Absent on legacy Codex samples; binds new estimates to one login and quota window. */
  scope: Schema.optionalKey(
    Schema.Struct({
      driver: Id,
      provider: Id,
      providerLabel: Id,
      instanceId: Id,
      accountKey: Id,
      workspaceId: Schema.optionalKey(Id),
      windowId: Id,
      windowLabel: Id,
    }),
  ),
});
export type EstimateSource = typeof EstimateSource.Type;

export const UsageEstimateStatus = Schema.Literals([
  "estimated",
  "reference_only",
  "collecting",
  "blocked",
]);
export const UsageIntervalEstimate = Schema.Struct({
  /** Missing on historical samples calculated from a continuous subinterval. */
  basis: Schema.optionalKey(Schema.Literals(["interval", "cycle_to_date"])),
  status: UsageEstimateStatus,
  source: EstimateSource,
  pricingId: Id,
  blockers: Schema.Array(Schema.String),
  limitations: Schema.Array(Schema.String),
  interval: Schema.NullOr(
    Schema.Struct({
      fromMs: Timestamp,
      untilMs: Timestamp,
      startUsedPercent: Schema.Finite,
      endUsedPercent: Schema.Finite,
      resetsAtMs: Timestamp,
      consumedPercent: Schema.Finite,
    }),
  ),
  records: Timestamp,
  costUsd: Schema.NullOr(Price),
  cycleEquivalentUsd: Schema.NullOr(Price),
  remainingEquivalentUsd: Schema.NullOr(Price),
  models: Schema.Array(
    Schema.Struct({
      model: Id,
      records: Timestamp,
      costUsd: Schema.NullOr(Price),
      quotaFreeRecords: Schema.optionalKey(Timestamp),
    }),
  ),
});
export type UsageIntervalEstimate = typeof UsageIntervalEstimate.Type;

export const SavedUsageEstimate = Schema.Struct({
  id: Schema.String,
  revision: Timestamp,
  computedAtMs: Schema.Finite,
  sampledAtMs: Schema.optionalKey(Timestamp),
  quotaResetAtMs: Schema.optionalKey(Timestamp),
  segmentStartMs: Schema.optionalKey(Timestamp),
  result: UsageIntervalEstimate,
});
export type SavedUsageEstimate = typeof SavedUsageEstimate.Type;

/** History keeps the price at sampling time; null values preserve breaks in the curve. */
export const UsageEstimatePoint = Schema.Struct({
  basis: Schema.optionalKey(Schema.Literals(["interval", "cycle_to_date"])),
  pricingId: Id,
  sampledAtMs: Timestamp,
  segmentStartMs: Timestamp,
  resetsAtMs: Timestamp,
  status: UsageEstimateStatus,
  fromMs: Schema.NullOr(Timestamp),
  consumedPercent: Schema.NullOr(Schema.Finite),
  costUsd: Schema.NullOr(Price),
  cycleEquivalentUsd: Schema.NullOr(Price),
  remainingEquivalentUsd: Schema.NullOr(Price),
});
export type UsageEstimatePoint = typeof UsageEstimatePoint.Type;

export const UsageEstimateSeries = Schema.Struct({
  source: EstimateSource,
  sourcePath: Schema.String,
  pricingAvailable: Schema.Boolean,
  current: Schema.NullOr(SavedUsageEstimate),
  history: Schema.Array(UsageEstimatePoint),
});
export type UsageEstimateSeries = typeof UsageEstimateSeries.Type;
