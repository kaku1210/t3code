// @effect-diagnostics globalDate:off -- Chart buckets follow the viewer's local calendar on web and Hermes.
import type { UsageEstimatePoint, UsageEstimateSeries, UsageSummary } from "@t3tools/contracts";
import type { UiLanguage } from "./uiLanguage.ts";
import type { LimitPoolWindow } from "./usageLimits.ts";

// Session snapshots of the same weekly reset can differ by a few seconds.
export const USAGE_ESTIMATE_RESET_TOLERANCE_MS = 60_000;

export function collectUsageEstimateSeries(
  environments: readonly {
    label: string;
    summary: Pick<UsageSummary, "subscriptionEstimates"> | null;
  }[],
) {
  const sources = new Map<string, { label: string; series: UsageEstimateSeries }>();
  for (const environment of environments) {
    for (const series of environment.summary?.subscriptionEstimates ?? []) {
      const previous = sources.get(series.source.id);
      if (
        !previous ||
        (series.current?.computedAtMs ?? 0) > (previous.series.current?.computedAtMs ?? 0)
      ) {
        sources.set(series.source.id, { label: environment.label, series });
      }
    }
  }
  return [...sources.values()];
}

export function usageEstimateState(series: UsageEstimateSeries, now: number) {
  if (!series.pricingAvailable) return "pricing_unavailable";
  const resetAtMs = series.current?.quotaResetAtMs ?? series.current?.result.interval?.resetsAtMs;
  if (resetAtMs !== undefined && resetAtMs > 0 && now >= resetAtMs) return "expired";
  return series.current?.result.status ?? "collecting";
}

/** Bind each series to its environment, login and quota window before selecting a sample. */
export function usageEstimatesForWindow(
  environments: readonly {
    environmentId: string;
    label: string;
    summary: Pick<UsageSummary, "subscriptionEstimates"> | null;
  }[],
  window: Pick<LimitPoolWindow, "kind" | "members">,
) {
  const entries = window.members.flatMap((member) => {
    const parsed = Date.parse(member.window.resetsAt ?? "");
    const resetAtMs = Number.isFinite(parsed) ? parsed : 0;
    const environmentIds = new Set<string>(
      member.account.environments.map((entry) => entry.environmentId),
    );
    return collectUsageEstimateSeries(
      environments.filter((environment) => environmentIds.has(environment.environmentId)),
    ).filter(({ series }) => {
      const scope = series.source.scope;
      if (scope) {
        if (scope.driver !== member.account.driver || scope.windowId !== member.window.id)
          return false;
        if (scope.workspaceId !== member.account.workspaceId) return false;
        if (member.account.limits.provider && scope.provider !== member.account.limits.provider.id)
          return false;
        const identity =
          member.account.email?.trim().toLowerCase() || member.account.limits.credentialFingerprint;
        if (
          identity
            ? series.source.accountId !== identity
            : !member.account.key.endsWith(`:${scope.instanceId}`)
        )
          return false;
      } else if (
        window.kind !== "weekly" ||
        window.members.length !== 1 ||
        member.account.driver !== "codex"
      )
        return false;
      const currentReset =
        series.current?.quotaResetAtMs ?? series.current?.result.interval?.resetsAtMs;
      return (
        (currentReset !== undefined &&
          Math.abs(currentReset - resetAtMs) <= USAGE_ESTIMATE_RESET_TOLERANCE_MS) ||
        (currentReset === undefined &&
          series.history.some(
            (point) => Math.abs(point.resetsAtMs - resetAtMs) <= USAGE_ESTIMATE_RESET_TOLERANCE_MS,
          ))
      );
    });
  });
  return [...new Map(entries.map((entry) => [entry.series.source.id, entry])).values()];
}

/** Return the latest usable sample for a quota card; an unavailable or expired estimate has no headline. */
export function latestUsageEstimate(
  entries: ReturnType<typeof collectUsageEstimateSeries>,
  now: number,
) {
  return entries
    .filter(({ series }) => {
      const state = usageEstimateState(series, now);
      return (
        (state === "estimated" || state === "reference_only") &&
        series.current?.result.cycleEquivalentUsd != null
      );
    })
    .sort(
      (left, right) =>
        (right.series.current?.sampledAtMs ?? right.series.current?.result.interval?.untilMs ?? 0) -
        (left.series.current?.sampledAtMs ?? left.series.current?.result.interval?.untilMs ?? 0),
    )[0];
}

export type EstimateResolution = "hour" | "day";

/** Different price or calculation bases must never be joined into one trend. */
function sameEstimateSegment(left: UsageEstimatePoint, right: UsageEstimatePoint) {
  return (
    left.pricingId === right.pricingId &&
    (left.basis ?? "interval") === (right.basis ?? "interval") &&
    (right.basis === "cycle_to_date"
      ? Math.abs(left.resetsAtMs - right.resetsAtMs) <= USAGE_ESTIMATE_RESET_TOLERANCE_MS
      : left.segmentStartMs === right.segmentStartMs && left.resetsAtMs === right.resetsAtMs)
  );
}

export function buildUsageEstimateChart(
  history: readonly UsageEstimatePoint[],
  resolution: EstimateResolution,
) {
  const buckets = new Map<number, { point: UsageEstimatePoint; interrupted: boolean }>();
  for (const point of [...history].sort((a, b) => a.sampledAtMs - b.sampledAtMs)) {
    const date = new Date(point.sampledAtMs);
    if (resolution === "day") date.setHours(0, 0, 0, 0);
    else date.setMinutes(0, 0, 0);
    const bucketMs = date.getTime();
    const previous = buckets.get(bucketMs);
    buckets.set(bucketMs, {
      point,
      interrupted:
        point.cycleEquivalentUsd === null ||
        (previous !== undefined &&
          (previous.interrupted || !sameEstimateSegment(previous.point, point))),
    });
  }
  const entries = [...buckets.entries()];
  // Collection before the first priced sample should not compress the visible trend.
  // Keep later invalid samples so interruptions still break the line.
  const firstPriced = entries.findIndex(([, { point }]) => point.cycleEquivalentUsd !== null);
  const samples = entries.slice(Math.max(0, firstPriced));
  const start = samples[0]?.[0] ?? 0;
  const end = samples.at(-1)?.[0] ?? start;
  const maxUsd = Math.max(1, ...samples.map(([, { point }]) => point.cycleEquivalentUsd ?? 0));
  const points = samples.map(([bucketMs, { point, interrupted }], index) => {
    const previous = samples[index - 1];
    const nextBucket = new Date(previous?.[0] ?? bucketMs);
    if (resolution === "day") nextBucket.setDate(nextBucket.getDate() + 1);
    else nextBucket.setHours(nextBucket.getHours() + 1);
    const connected =
      previous !== undefined &&
      !interrupted &&
      previous[1].point.cycleEquivalentUsd !== null &&
      point.cycleEquivalentUsd !== null &&
      sameEstimateSegment(previous[1].point, point) &&
      bucketMs <= nextBucket.getTime();
    return {
      ...point,
      connected,
      x: end === start ? 50 : ((bucketMs - start) / (end - start)) * 100,
      y: point.cycleEquivalentUsd === null ? null : 100 - (point.cycleEquivalentUsd / maxUsd) * 100,
    };
  });
  return { points, maxUsd };
}

const english = {
  freeRule:
    "Free-model requests are excluded from quota valuation; API-value usage still shows list prices.",
  customRule:
    "Custom token prices apply to this estimate. Saved historical points keep their original prices.",
  freeRequests: "free requests",
  missingPrices: "Missing prices",
  section: "API equivalent estimates and history",
  total: "Estimated cycle total",
  title: "API equivalent",
  cycle: "Estimated full cycle",
  remaining: "Remaining at sample time",
  recorded: "Recorded in interval",
  consumed: "Quota used",
  sample: "Sample interval",
  cycleToDate: "Current cycle to date",
  cycleRecorded: "Recorded this cycle",
  cycleCollectingHelp:
    "An estimate appears after this cycle has used at least 5 percentage points and local usage is recorded.",
  cycleCaveat:
    "Assuming this cycle's usage is on this device: recorded cycle cost ÷ consumed quota. Includes records through the quota sample; cached quota and missing usage can affect this API equivalent estimate.",
  accountCaveat:
    "Based on account history cached on this device. Recorded API cost ÷ consumed quota; this may include usage from other devices.",
  intervalCollectingHelp:
    "The provider does not report the cycle start. Collecting matching usage and quota observations; an estimate appears after at least 5 percentage points of change.",
  device: "Device",
  history: "Full-cycle estimate history",
  hour: "Hourly",
  day: "Daily",
  details: "Sample details",
  collecting: "Collecting samples",
  reference_only: "Reference only",
  estimated: "Local interval estimate",
  blocked: "Cannot estimate this interval",
  expired: "Sample cycle has expired",
  pricing_unavailable: "Model prices unavailable",
  collectingHelp:
    "An estimate appears after at least 5 percentage points of usage in one continuous local interval.",
  blockedHelp:
    "The interval contains incomplete prices, unknown speed, invalid records or inconsistent quota observations.",
  expiredHelp: "Waiting for samples from the new cycle. Previous estimates remain in history.",
  pricingHelp: "Refresh usage after model prices become available.",
  caveat:
    "Based on this device's recorded usage mix and API prices. Account ownership is unconfirmed; cached quota and unrecorded usage can affect the estimate. This is not a subscription balance.",
  historyHelp:
    "Last sample per hour/day · gaps and cycle resets remain disconnected · historical prices are preserved.",
  noHistory: "No estimate yet. History grows as new quota samples arrive.",
  noSource:
    "No local quota samples yet. Use this provider on this environment, then refresh usage.",
  loading: "Loading local estimates…",
  unavailable: "Local estimates could not be loaded.",
  unsupported: "This environment does not provide subscription estimates yet.",
  price: "Price version",
  records: "Requests",
  model: "Model",
  percentagePoints: "pp",
  noInterval: "Waiting for a complete interval",
};
const chinese: typeof english = {
  freeRule: "免费模型不计入额度折算费用；用量面板的 API 等值仍按标价展示。",
  customRule: "此估算采用了自定义单价；已保存的历史点保留原价。",
  freeRequests: "次免费请求",
  missingPrices: "缺少单价",
  section: "API 等值估算与历史",
  total: "本周期预估总价值",
  title: "API 等值",
  cycle: "整周期估算",
  remaining: "样本时剩余估算",
  recorded: "区间已记录费用",
  consumed: "额度消耗",
  sample: "样本区间",
  cycleToDate: "本周期累计估算",
  cycleRecorded: "本周期已记录费用",
  cycleCollectingHelp: "本周期累计消耗至少 5 个百分点且有本机用量记录后显示估算。",
  cycleCaveat:
    "按本周期用量均来自本设备计算：周期已记录费用 ÷ 已消耗比例。费用统计至额度采样时刻；额度缓存和漏记用量会影响 API 等值估算。",
  accountCaveat:
    "按缓存到本机的账号用量历史折算：已记录 API 费用 ÷ 已消耗比例；此历史可能包含其他设备的用量。",
  intervalCollectingHelp:
    "服务商未提供周期起点，正在采集同一段时间的用量与额度；累计消耗变化达到 5 个百分点后显示估算。",
  device: "设备",
  history: "整周期等值历史",
  hour: "按小时",
  day: "按天",
  details: "样本详情",
  collecting: "采集中",
  reference_only: "仅供参考",
  estimated: "本机区间估算",
  blocked: "当前区间不可估算",
  expired: "样本周期已结束",
  pricing_unavailable: "模型价格暂不可用",
  collectingHelp: "同一本机连续区间内累计消耗至少 5 个百分点后显示估算。",
  blockedHelp: "区间包含价格缺失、速度档未知、无效记录或不一致的额度观测。",
  expiredHelp: "等待新周期样本，旧估算仍保留在历史中。",
  pricingHelp: "模型价格可用后，请刷新用量。",
  caveat:
    "按本设备已记录的用法与 API 价格折算。账号归属尚未确认，额度缓存和未记录消耗会影响结果；此金额不代表订阅余额。",
  historyHelp: "每小时或每天取最后一个样本；缺失区间和周期重置不连线，历史价格保持不变。",
  noHistory: "尚无可显示的估算，后续额度样本会自动形成历史。",
  noSource: "尚无本地额度样本。在此环境使用该服务商后，刷新用量即可采集。",
  loading: "正在读取本地估算…",
  unavailable: "未能读取本地估算。",
  unsupported: "此环境尚未提供订阅估算。",
  price: "价格版本",
  records: "请求数",
  model: "模型",
  percentagePoints: "个百分点",
  noInterval: "等待完整区间",
};
export const usageEstimateText = (language: UiLanguage) =>
  language === "zh-CN" ? chinese : english;

/** Explain observable missing data without promising a made-up estimate. */
export function usageEstimateBlockerText(blockers: readonly string[], language: UiLanguage) {
  const reasons: Readonly<Record<string, readonly [string, string]>> = {
    account_ambiguous: [
      "Several logins share this history; usage cannot be assigned to this account.",
      "多个账号共用此用量目录，暂时无法确认本账号的用量。",
    ],
    usage_unavailable: [
      "No usage history is available for this account.",
      "尚无此账号的用量记录。",
    ],
    usage_incomplete: [
      "Usage history is incomplete or still refreshing. Refresh to retry.",
      "用量历史不完整或仍在刷新，请刷新后重试。",
    ],
    quota_scope_unknown: [
      "History does not identify which quota pool paid for these requests.",
      "用量记录未标明这些请求归属哪个额度池，暂时无法折算此分组。",
    ],
    reset_unknown: [
      "The provider has not reported a quota reset time.",
      "服务商尚未提供额度重置时间。",
    ],
    unpriced_usage: [
      "Some models have no API price in the current price table.",
      "当前价格表缺少部分模型的 API 价格。",
    ],
    quota_without_paid_usage: [
      "Quota was consumed, but all recorded requests were free; paid usage is missing.",
      "额度已消耗，但本段记录全部是免费请求，缺少对应的计费用量。",
    ],
    speed_unconfirmed: [
      "The request's speed tier is not confirmed.",
      "部分请求的速度档位尚未确认。",
    ],
  };
  return [
    ...new Set(
      blockers.map(
        (reason) =>
          reasons[reason]?.[language === "zh-CN" ? 1 : 0] ??
          usageEstimateText(language).blockedHelp,
      ),
    ),
  ].join(" ");
}
