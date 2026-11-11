import { describe, expect, it } from "@effect/vitest";
import type { EstimateSource } from "@t3tools/contracts";

import { parseCodexEstimateTranscript } from "./codexEstimateTranscript.ts";
import { withDefaultPrices } from "./usageDefaultPrices.ts";
import {
  estimateUsageInterval,
  estimateUsageCycle,
  selectUsageEstimateCycleSamples,
  type EstimateEvent,
  type EstimatePricing,
} from "./usageEstimate.ts";

const start = Date.parse("2026-11-09T00:00:00Z");
const end = start + 4 * 3_600_000;
const reset = start + 7 * 86_400_000;
const source: EstimateSource = {
  id: "account-segment",
  deviceId: "device-a",
  accountId: "account-a",
  coverage: "device",
};
const pricing: EstimatePricing = {
  id: "fixture-prices",
  description: "Deterministic test rates",
  rates: {
    "fixture-model": {
      inputCostPerToken: 0.00001,
      cacheReadCostPerToken: 0.000001,
      cacheCreationCostPerToken: 0.00001,
      outputCostPerToken: 0.00003,
      fast: null,
      ultrafast: null,
    },
  },
};
const quota = (
  id: string,
  timestampMs: number,
  usedPercent: number,
): Extract<EstimateEvent, { kind: "quota" }> => ({
  id,
  kind: "quota",
  sessionId: "session-a",
  timestampMs,
  usedPercent,
  windowMinutes: 10_080,
  resetsAtMs: reset,
  limitId: "codex",
  plan: "test",
  origin: "account_probe",
});
const usage: EstimateEvent = {
  id: "request",
  kind: "usage",
  sessionId: "session-a",
  timestampMs: end,
  model: "fixture-model",
  speed: "standard",
  speedKnown: true,
  totals: {
    uncachedInputTokens: 7_500_000,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
};
const events = [quota("start", start, 15), usage, quota("end", end, 20)];
const bounds = { fromMs: start, untilMs: end };

describe("cycle-to-date local estimates", () => {
  it("excludes free SWE requests from a confirmed Devin quota but keeps unknown internal models visible", () => {
    const scoped: EstimateSource = {
      ...source,
      scope: {
        driver: "acpRegistry",
        provider: "devin",
        providerLabel: "Devin",
        instanceId: "devin",
        accountKey: "account-a",
        windowId: "weekly",
        windowLabel: "Weekly",
      },
    };
    const data: EstimateEvent[] = [
      usage,
      { ...usage, id: "swe", model: "swe-2-max" },
      { ...quota("end", end, 50), limitId: "weekly", plan: "Pro" },
    ];
    const rates: EstimatePricing = {
      ...pricing,
      rates: Object.fromEntries(withDefaultPrices(new Map(Object.entries(pricing.rates)))),
    };
    const result = estimateUsageCycle(scoped, data, rates, { ...bounds, resetsAtMs: reset });
    expect(result.cycleEquivalentUsd).toBe(150);
    expect(result.models.find((model) => model.model === "swe-2-max")).toMatchObject({
      costUsd: 0,
      quotaFreeRecords: 1,
    });
    const planDiscovered = estimateUsageCycle(
      scoped,
      [{ ...quota("first-unknown", start, 0), limitId: "weekly", plan: null }, ...data],
      rates,
      { ...bounds, resetsAtMs: reset },
    );
    expect(planDiscovered.blockers).not.toContain("cycle_or_plan_changed");
    expect(planDiscovered.models.find((model) => model.model === "swe-2-max")?.costUsd).toBe(0);
    const freeOnly = estimateUsageCycle(
      scoped,
      data.filter((event) => event.id !== usage.id),
      rates,
      { ...bounds, resetsAtMs: reset },
    );
    expect(freeOnly.blockers).toContain("quota_without_paid_usage");
    expect(freeOnly.cycleEquivalentUsd).toBeNull();
    const missing = estimateUsageCycle(
      scoped,
      [...data, { ...usage, id: "internal", model: "compactor" }],
      rates,
      { ...bounds, resetsAtMs: reset },
    );
    expect(missing.blockers).toContain("unpriced_usage");
    expect(missing.models.find((model) => model.model === "compactor")?.costUsd).toBeNull();
  });
  it.each(["daily", "five_hour", "weekly", "subscription"])(
    "prices an account-bound %s window without including other quota buckets",
    (windowId) => {
      const scoped: EstimateSource = {
        ...source,
        scope: {
          driver: "test",
          provider: "test",
          providerLabel: "Test",
          instanceId: "test",
          accountKey: "account-a",
          windowId,
          windowLabel: windowId,
        },
      };
      const data: EstimateEvent[] = [
        usage,
        {
          ...quota("scoped", end, 100),
          limitId: windowId,
          windowMinutes: 1440,
          startsAtMs: start,
          resetsAtMs: start + 86400000,
        },
        quota("other-window", end, 10),
      ];
      const samples = selectUsageEstimateCycleSamples(data, scoped);
      expect(samples).toHaveLength(1);
      const result = estimateUsageCycle(scoped, data, pricing, samples[0]!);
      expect(result.cycleEquivalentUsd).toBe(75);
      expect(result.remainingEquivalentUsd).toBe(0);
    },
  );
  it("uses all cycle usage through the high-watermark sample despite stale cached quotas and reset jitter", () => {
    const cachedQuota = (id: string, time: number, percent: number) => ({
      ...quota(id, time, percent),
      origin: "session_cache" as const,
    });
    const data: EstimateEvent[] = [
      { ...usage, id: "previous-cycle", timestampMs: start - 1 },
      { ...usage, id: "first-request", timestampMs: start + 1000 },
      cachedQuota("initial", start + 1000, 15),
      { ...usage, id: "second-request", timestampMs: start + 2000 },
      cachedQuota("old-cache", start + 2000, 14),
      { ...usage, id: "third-request", timestampMs: end },
      { ...cachedQuota("peak", end, 20), resetsAtMs: reset + 20000 },
      { ...usage, id: "unsettled-tail", timestampMs: end + 1000 },
      cachedQuota("stale-tail", end + 1000, 19),
    ];
    const samples = selectUsageEstimateCycleSamples(data);
    expect(samples).toHaveLength(2);
    const sample = samples.at(-1)!;
    expect(sample).toMatchObject({ fromMs: start, untilMs: end, resetsAtMs: reset });
    const result = estimateUsageCycle(source, data, pricing, sample);
    expect(result).toMatchObject({
      basis: "cycle_to_date",
      status: "reference_only",
      records: 3,
      costUsd: 225,
      cycleEquivalentUsd: 1125,
      remainingEquivalentUsd: 900,
      interval: { fromMs: start, startUsedPercent: 0, consumedPercent: 20 },
    });
    expect(result.limitations).toContain("assumes_local_cycle_coverage");
  });

  it("starts from the new cycle and never carries the preceding cycle's cost", () => {
    const nextStart = reset;
    const nextQuota = {
      ...quota("new-cycle", nextStart + 1000, 5),
      resetsAtMs: nextStart + 604800000,
    };
    const data = [
      ...events,
      { ...usage, id: "new-usage", timestampMs: nextStart + 1000 },
      nextQuota,
    ];
    const samples = selectUsageEstimateCycleSamples(data);
    expect(samples).toHaveLength(1);
    expect(estimateUsageCycle(source, data, pricing, samples[0]!)).toMatchObject({
      records: 1,
      costUsd: 75,
      cycleEquivalentUsd: 1500,
      interval: { fromMs: nextStart, consumedPercent: 5 },
    });
  });

  it.each(["unpriced_usage", "speed_unconfirmed", "cycle_or_plan_changed"])(
    "keeps the cycle amount unavailable for %s",
    (reason) => {
      const data: EstimateEvent[] = [
        {
          ...quota("first", start + 1000, 10),
          plan: reason === "cycle_or_plan_changed" ? "other" : "test",
        },
        {
          ...usage,
          model: reason === "unpriced_usage" ? "unknown-model" : usage.model,
          speedKnown: reason !== "speed_unconfirmed",
        },
        quota("last", end, 20),
      ];
      const sample = selectUsageEstimateCycleSamples(data).at(-1)!;
      const result = estimateUsageCycle(source, data, pricing, sample);
      expect(result.status).toBe("blocked");
      expect(result.cycleEquivalentUsd).toBeNull();
      expect(result.blockers).toContain(reason);
    },
  );
});

describe("local usage interval estimates", () => {
  it("prices only (start,end] and keeps recorded cost separate from extrapolation", () => {
    const result = estimateUsageInterval(
      source,
      [...events, { ...usage, id: "before-baseline", timestampMs: start }],
      pricing,
      bounds,
    );
    expect(result).toMatchObject({
      status: "estimated",
      records: 1,
      costUsd: expect.closeTo(75),
      cycleEquivalentUsd: expect.closeTo(1500),
      remainingEquivalentUsd: expect.closeTo(1200),
    });
    expect(result.interval?.consumedPercent).toBe(5);
  });

  it("never turns an unbound cached log sample into a current subscription estimate", () => {
    const cached = events.map((event) =>
      event.kind === "quota" ? { ...event, origin: "session_cache" as const } : event,
    );
    const result = estimateUsageInterval(
      { ...source, accountId: null, coverage: "selected_sessions" },
      cached,
      pricing,
      bounds,
    );
    expect(result.status).toBe("reference_only");
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        "account_unconfirmed",
        "selected_sessions_only",
        "quota_may_be_cached",
      ]),
    );
  });

  it.each([
    {
      name: "unchanged quota",
      data: [events[0]!, usage, quota("end", end, 15)],
      status: "collecting",
      reason: null,
    },
    {
      name: "small interval",
      data: [events[0]!, usage, quota("end", end, 17)],
      status: "collecting",
      reason: null,
    },
    {
      name: "cached regression",
      data: [events[0]!, quota("old", start + 1000, 14), usage, events[2]!],
      status: "blocked",
      reason: "quota_regressed",
    },
    {
      name: "cycle reset",
      data: [events[0]!, usage, { ...quota("end", end, 20), resetsAtMs: reset + 86_400_000 }],
      status: "blocked",
      reason: "cycle_or_plan_changed",
    },
    {
      name: "unknown speed",
      data: [events[0]!, { ...usage, speedKnown: false }, events[2]!],
      status: "blocked",
      reason: "speed_unconfirmed",
    },
    {
      name: "unknown price",
      data: [events[0]!, { ...usage, model: "unknown-model" }, events[2]!],
      status: "blocked",
      reason: "unpriced_usage",
    },
    {
      name: "corrupt usage",
      data: [
        ...events,
        {
          id: "bad",
          kind: "issue" as const,
          timestampMs: end,
          sessionId: "session-a",
          reason: "malformed_usage" as const,
        },
      ],
      status: "blocked",
      reason: "malformed_usage",
    },
  ])("handles $name without inventing a balance", ({ data, status, reason }) => {
    const result = estimateUsageInterval(source, data, pricing, bounds);
    expect(result.status).toBe(status);
    expect(result.cycleEquivalentUsd).toBeNull();
    if (reason) expect(result.blockers).toContain(reason);
    if (reason === "unpriced_usage" || reason === "speed_unconfirmed")
      expect(result.costUsd).toBeNull();
  });

  it("does not treat a monthly window in primary as a weekly allowance", () => {
    const monthly = events.map((event) =>
      event.kind === "quota" ? { ...event, windowMinutes: 43_200 } : event,
    );
    expect(estimateUsageInterval(source, monthly, pricing, bounds)).toMatchObject({
      status: "collecting",
      interval: null,
      cycleEquivalentUsd: null,
    });
  });
});

it("imports paired log observations without inferring settlement or charging repeated counters", () => {
  const totals = {
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 10,
    reasoning_output_tokens: 3,
    total_tokens: 110,
  };
  const tick = {
    type: "event_msg",
    timestamp: "2026-11-09T00:00:00Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: totals, total_token_usage: totals },
      rate_limits: {
        limit_id: "codex",
        plan_type: "test",
        primary: { used_percent: 15, window_minutes: 10_080, resets_at: reset / 1000 },
        secondary: null,
      },
    },
  };
  const lines =
    [
      { type: "session_meta", payload: { id: "session-a", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "fixture-model", turn_id: "turn" } },
      {
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } },
      },
      tick,
      tick,
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  const parsed = parseCodexEstimateTranscript(lines + '{"unfinished":');
  expect(parsed.pendingTail).toBe(true);
  expect(parsed.events.filter((event) => event.kind === "usage")).toMatchObject([
    {
      speed: "fast",
      speedKnown: true,
      totals: {
        uncachedInputTokens: 20,
        cachedInputTokens: 80,
        outputTokens: 10,
        reasoningTokens: 3,
      },
    },
  ]);
  expect(
    parsed.events
      .filter((event) => event.kind === "quota")
      .every((event) => event.origin === "session_cache"),
  ).toBe(true);
  expect(parseCodexEstimateTranscript(lines).events).toEqual(parsed.events);
});
