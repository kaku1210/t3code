// @effect-diagnostics globalDate:off -- Fixed local calendar fixtures for hourly and daily chart buckets.
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  type UsageEstimatePoint,
  type UsageEstimateSeries,
} from "@t3tools/contracts";
import {
  buildUsageEstimateChart,
  collectUsageEstimateSeries,
  usageEstimateState,
  usageEstimatesForWindow,
  latestUsageEstimate,
} from "./usageEstimates.ts";
import type { LimitPoolMember } from "./usageLimits.ts";

const time = new Date(2026, 10, 9, 12).getTime();
const hour = 3600000;
const point = (offset: number, value: number | null = 1500): UsageEstimatePoint => ({
  sampledAtMs: time + offset * hour,
  segmentStartMs: time,
  resetsAtMs: time + 7 * 86400000,
  pricingId: "price-a",
  status: value === null ? "blocked" : "reference_only",
  fromMs: time,
  consumedPercent: 5,
  costUsd: 75,
  cycleEquivalentUsd: value,
  remainingEquivalentUsd: value === null ? null : value * 0.8,
});
const series: UsageEstimateSeries = {
  source: { id: "a", deviceId: "device-a", accountId: null, coverage: "selected_sessions" },
  sourcePath: "/codex",
  pricingAvailable: true,
  current: null,
  history: [],
};

describe("subscription estimate presentation", () => {
  it("binds generic samples to the login, workspace, provider and exact quota bucket", () => {
    const reset = point(0).resetsAtMs;
    const scope = {
      driver: "acpRegistry",
      provider: "devin",
      providerLabel: "Devin",
      instanceId: "devin",
      accountKey: "login",
      windowId: "daily",
      windowLabel: "Daily",
      workspaceId: "team-a",
    };
    const scoped = {
      ...series,
      source: { ...series.source, scope, accountId: "a@example.com" },
      history: [point(0)],
    };
    const environments = [
      { environmentId: "desk", label: "Desk", summary: { subscriptionEstimates: [scoped] } },
    ];
    const member: LimitPoolMember = {
      account: {
        key: "desk:devin",
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: null,
        email: "a@example.com",
        workspaceId: "team-a",
        plan: undefined,
        accentColor: undefined,
        environments: [{ environmentId: EnvironmentId.make("desk"), label: "Desk" }],
        sourceLabel: null,
        redeem: null,
        limits: {
          checkedAt: new Date(time).toISOString(),
          provider: { id: "devin", label: "Devin" },
          windows: [],
        },
      },
      window: {
        id: "daily",
        kind: "other",
        label: "Daily",
        usedPercent: 100,
        resetsAt: new Date(reset).toISOString(),
      },
      refillPercent: 0,
    };
    const pool = { kind: "other" as const, members: [member] };
    expect(usageEstimatesForWindow(environments, pool)).toHaveLength(1);
    for (const mismatch of [
      { ...member, window: { ...member.window, id: "weekly" } },
      { ...member, account: { ...member.account, email: "b@example.com" } },
      { ...member, account: { ...member.account, workspaceId: "team-b" } },
      { ...member, account: { ...member.account, driver: ProviderDriverKind.make("codex") } },
    ]) {
      expect(usageEstimatesForWindow(environments, { ...pool, members: [mismatch] })).toEqual([]);
    }
  });
  it("attaches samples only to the matching environment and weekly reset, excluding pooled accounts", () => {
    const reset = point(0).resetsAtMs;
    const environments = [
      {
        environmentId: "desk",
        label: "Desk",
        summary: { subscriptionEstimates: [{ ...series, history: [point(0)] }] },
      },
    ];
    const member: LimitPoolMember = {
      account: {
        key: "account",
        driver: ProviderDriverKind.make("codex"),
        displayName: null,
        email: undefined,
        plan: undefined,
        accentColor: undefined,
        environments: [{ environmentId: EnvironmentId.make("desk"), label: "Desk" }],
        sourceLabel: null,
        redeem: null,
        limits: { checkedAt: new Date(time).toISOString(), windows: [] },
      },
      window: {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 20,
        resetsAt: new Date(reset).toISOString(),
      },
      refillPercent: 0,
    };
    const window = { kind: "weekly" as const, members: [member] };
    expect(usageEstimatesForWindow(environments, window)).toHaveLength(1);
    expect(
      usageEstimatesForWindow(environments, {
        ...window,
        members: [
          {
            ...member,
            window: { ...member.window, resetsAt: new Date(reset + 20000).toISOString() },
          },
        ],
      }),
    ).toHaveLength(1);
    expect(usageEstimatesForWindow(environments, { ...window, kind: "session" })).toEqual([]);
    expect(usageEstimatesForWindow(environments, { ...window, members: [member, member] })).toEqual(
      [],
    );
    expect(
      usageEstimatesForWindow([{ ...environments[0]!, environmentId: "another-device" }], window),
    ).toEqual([]);
    expect(
      usageEstimatesForWindow(environments, {
        ...window,
        members: [
          {
            ...member,
            window: { ...member.window, resetsAt: new Date(reset + hour).toISOString() },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("chooses one latest usable headline without adding devices or showing expired and collecting values", () => {
    const priced: UsageEstimateSeries = {
      ...series,
      current: {
        id: "sample",
        revision: 1,
        computedAtMs: time,
        result: {
          status: "reference_only",
          source: series.source,
          pricingId: "price-a",
          blockers: [],
          limitations: ["account_unconfirmed"],
          interval: {
            fromMs: time - hour,
            untilMs: time,
            startUsedPercent: 15,
            endUsedPercent: 20,
            resetsAtMs: point(0).resetsAtMs,
            consumedPercent: 5,
          },
          records: 10,
          costUsd: 75,
          cycleEquivalentUsd: 1500,
          remainingEquivalentUsd: 1200,
          models: [],
        },
      },
    };
    const newer = { ...priced, current: { ...priced.current!, sampledAtMs: time + hour } };
    const entries = [
      { label: "old", series: priced },
      { label: "new", series: newer },
    ];
    expect(latestUsageEstimate(entries, time + hour)?.label).toBe("new");
    expect(latestUsageEstimate(entries, point(0).resetsAtMs)).toBeUndefined();
    for (const status of ["collecting", "blocked"] as const) {
      expect(
        latestUsageEstimate(
          [
            {
              label: "no estimate",
              series: {
                ...priced,
                current: { ...priced.current!, result: { ...priced.current!.result, status } },
              },
            },
          ],
          time,
        ),
      ).toBeUndefined();
    }
    expect(
      latestUsageEstimate(
        [{ label: "no price", series: { ...priced, pricingAvailable: false } }],
        time,
      ),
    ).toBeUndefined();
  });
  it("keeps the last sample in each local hour/day, including an invalid last sample", () => {
    const history = [point(0), point(0.5, 1800), point(1), point(1.5, null)];
    expect(
      buildUsageEstimateChart(history, "hour").points.map((p) => p.cycleEquivalentUsd),
    ).toEqual([1800, null]);
    expect(buildUsageEstimateChart(history, "day").points.map((p) => p.cycleEquivalentUsd)).toEqual(
      [null],
    );
  });
  it("never joins missing buckets, invalid observations, reset segments or price versions", () => {
    const history = [
      point(0),
      point(1),
      point(3),
      point(3.5, null),
      point(4),
      { ...point(5), segmentStartMs: time + hour },
      { ...point(6), segmentStartMs: time + hour, pricingId: "price-b" },
    ];
    expect(buildUsageEstimateChart(history, "hour").points.map((p) => p.connected)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
  it("starts the timeline at the first priced bucket while retaining later gaps", () => {
    const chart = buildUsageEstimateChart(
      [point(-200, null), point(-100, null), point(0), point(1, null), point(2, 1600)],
      "hour",
    );
    expect(chart.points.map((sample) => sample.cycleEquivalentUsd)).toEqual([1500, null, 1600]);
    expect(chart.points.map((sample) => sample.x)).toEqual([0, 50, 100]);
    expect(chart.points.map((sample) => sample.connected)).toEqual([false, false, false]);
  });
  it("keeps cumulative samples connected across reset-clock jitter and separates legacy interval values", () => {
    const cycle = { ...point(0), basis: "cycle_to_date" as const };
    const next = {
      ...point(1),
      basis: "cycle_to_date" as const,
      resetsAtMs: cycle.resetsAtMs + 20000,
      segmentStartMs: time + 20000,
    };
    expect(
      buildUsageEstimateChart([cycle, next, point(2)], "hour").points.map(
        (value) => value.connected,
      ),
    ).toEqual([false, true, false]);
  });
  it("deduplicates repeated origins without combining devices or adding their estimates", () => {
    const b = { ...series, source: { ...series.source, id: "b", deviceId: "device-b" } };
    const entries = collectUsageEstimateSeries([
      { label: "first", summary: { subscriptionEstimates: [series] } },
      { label: "alias", summary: { subscriptionEstimates: [series, b] } },
      { label: "old", summary: {} },
    ]);
    expect(entries.map((entry) => entry.series.source.id)).toEqual(["a", "b"]);
    expect(usageEstimateState(series, time)).toBe("collecting");
    expect(usageEstimateState({ ...series, pricingAvailable: false }, time)).toBe(
      "pricing_unavailable",
    );
  });
});
