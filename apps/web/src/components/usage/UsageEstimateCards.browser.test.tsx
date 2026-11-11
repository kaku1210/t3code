import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageEstimateSeries,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UiLanguageContext } from "../../i18n/useUiLanguage";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const start = Date.parse("2026-11-09T10:00:00Z");
const end = start + 3600000;
const reset = start + 7 * 86400000;
const source = {
  id: "fixture-source",
  deviceId: "test-device",
  accountId: null,
  coverage: "selected_sessions",
} as const;
const series: UsageEstimateSeries = {
  source,
  sourcePath: "/fixture/codex",
  pricingAvailable: true,
  current: {
    id: "sample",
    revision: 1,
    computedAtMs: end,
    sampledAtMs: end,
    segmentStartMs: start,
    quotaResetAtMs: reset,
    result: {
      status: "reference_only",
      source,
      pricingId: "fixture-prices",
      blockers: [],
      limitations: ["account_unconfirmed"],
      interval: {
        fromMs: start,
        untilMs: end,
        startUsedPercent: 15,
        endUsedPercent: 20,
        resetsAtMs: reset,
        consumedPercent: 5,
      },
      records: 10,
      costUsd: 75,
      cycleEquivalentUsd: 1500,
      remainingEquivalentUsd: 1200,
      models: [{ model: "fixture-model", records: 10, costUsd: 75 }],
    },
  },
  history: [start, end].map((sampledAtMs, index) => ({
    sampledAtMs,
    segmentStartMs: start,
    resetsAtMs: reset,
    pricingId: "fixture-prices",
    status: "reference_only",
    fromMs: start - 3600000,
    consumedPercent: 5,
    costUsd: index === 0 ? 60 : 75,
    cycleEquivalentUsd: index === 0 ? 1200 : 1500,
    remainingEquivalentUsd: 1200,
  })),
};
const environment: EnvironmentUsageStatus = {
  environmentId: EnvironmentId.make("fixture-environment"),
  label: "Test desktop",
  isPending: false,
  isConnected: true,
  canReadDiagnostics: true,
  needsCursorKeychainAccess: false,
  error: null,
  summary: {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: new Date(end).toISOString(),
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-11-09"),
    untilDay: UsageDay.make("2026-11-10"),
    buckets: [],
    sources: [],
    pricing: { status: "fresh", source: "fixture", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 0,
    subscriptionEstimates: [series],
  },
};

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date(end).toISOString(),
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: new Date(end).toISOString(),
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: new Date(end + 3600000).toISOString(),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 20,
        windowDurationMins: 10080,
        resetsAt: new Date(reset).toISOString(),
      },
    ],
  },
};
const presentations = new Map([
  [
    environment.environmentId,
    {
      entry: { target: { label: environment.label } },
      serverConfig: { providers: [provider] },
    },
  ],
]);

it("switches curve resolution, reveals provenance and retires expired current values while preserving history", async () => {
  const content = (now: number) => (
    <UiLanguageContext value="zh-CN">
      <UsageLimitsPooled
        presentations={presentations}
        now={now}
        estimateEnvironments={[environment]}
      />
    </UiLanguageContext>
  );
  await using screen = await render(content(end));
  const disclosure = screen.getByRole("button", { name: "API 等值估算与历史", exact: true });
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("本周期预估总价值", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("≈ $1,500.00", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "整周期等值历史" }))
    .not.toBeInTheDocument();
  await disclosure.click();
  await expect.element(screen.getByText("≈ $1,500.00", { exact: true }).last()).toBeVisible();
  await expect.element(screen.getByText("≈ $1,200.00", { exact: true })).toBeVisible();
  const points = screen.getByRole("button", { name: /区间已记录费用/ });
  await vi.waitFor(() => expect(points.elements()).toHaveLength(1));
  await screen.getByRole("button", { name: "按小时", exact: true }).click();
  await vi.waitFor(() => expect(points.elements()).toHaveLength(2));
  await points.first().click();
  await screen.getByText("样本详情", { exact: true }).click();
  await expect
    .element(screen.getByText("设备: test-device · /fixture/codex", { exact: true }))
    .toBeVisible();
  await screen.rerender(content(reset));
  await expect.element(screen.getByText("样本周期已结束", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("≈ $1,500.00", { exact: true })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(points.elements()).toHaveLength(2));
  await disclosure.click();
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("样本周期已结束", { exact: true })).not.toBeInTheDocument();
});

it("omits the summary and separate estimate area without samples, while collecting still has details", async () => {
  const empty = { ...environment, summary: { ...environment.summary!, subscriptionEstimates: [] } };
  const content = (entry: EnvironmentUsageStatus) => (
    <UsageLimitsPooled presentations={presentations} now={end} estimateEnvironments={[entry]} />
  );
  await using screen = await render(content(empty));
  await expect.element(screen.getByText("80%", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText(/Estimated cycle total/)).not.toBeInTheDocument();
  await expect
    .element(
      screen.getByRole("button", { name: "API equivalent estimates and history", exact: true }),
    )
    .not.toBeInTheDocument();
  await screen.rerender(
    content({
      ...environment,
      summary: {
        ...environment.summary!,
        subscriptionEstimates: [
          {
            ...series,
            current: {
              ...series.current!,
              result: {
                ...series.current!.result,
                status: "collecting",
                cycleEquivalentUsd: null,
                remainingEquivalentUsd: null,
              },
            },
          },
        ],
      },
    }),
  );
  await expect.element(screen.getByText(/Estimated cycle total/)).not.toBeInTheDocument();
  await screen
    .getByRole("button", { name: "API equivalent estimates and history", exact: true })
    .click();
  await expect.element(screen.getByText("Collecting samples", { exact: true })).toBeVisible();
});

it("keeps an exhausted Devin daily card expandable and explains missing prices", async () => {
  const devin: ServerProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("devin"),
    driver: ProviderDriverKind.make("acpRegistry"),
    auth: { status: "authenticated", email: "test@example.com" },
    usageLimits: {
      checkedAt: new Date(end).toISOString(),
      provider: { id: "devin", label: "Devin" },
      subscription: { periodEndsAt: new Date(end + 86400000).toISOString() },
      windows: [
        {
          id: "daily",
          kind: "other",
          label: "Daily",
          usedPercent: 100,
          resetsAt: new Date(reset).toISOString(),
          windowDurationMins: 1440,
        },
      ],
    },
  };
  const scope = {
    driver: "acpRegistry",
    provider: "devin",
    providerLabel: "Devin",
    instanceId: "devin",
    accountKey: "account",
    windowId: "daily",
    windowLabel: "Daily",
  };
  const missing: UsageEstimateSeries = {
    ...series,
    source: { ...source, accountId: "test@example.com", scope },
    current: {
      ...series.current!,
      result: {
        ...series.current!.result,
        status: "blocked",
        blockers: ["unpriced_usage"],
        cycleEquivalentUsd: null,
        remainingEquivalentUsd: null,
      },
    },
  };
  await using screen = await render(
    <UiLanguageContext value="zh-CN">
      <UsageLimitsPooled
        presentations={
          new Map([
            [
              environment.environmentId,
              {
                entry: { target: { label: environment.label } },
                serverConfig: { providers: [devin] },
              },
            ],
          ])
        }
        now={end}
        estimateEnvironments={[
          {
            ...environment,
            summary: { ...environment.summary!, subscriptionEstimates: [missing] },
          },
        ]}
      />
    </UiLanguageContext>,
  );
  await expect.element(screen.getByText("Daily", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/本期结束.*1 天内/)).toBeVisible();
  await expect.element(screen.getByText("0%", { exact: true }).first()).toBeVisible();
  const disclosure = screen.getByRole("button", { name: "API 等值估算与历史", exact: true });
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect
    .element(screen.getByText("当前价格表缺少部分模型的 API 价格。", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "整周期等值历史", exact: true }))
    .toBeVisible();
});
