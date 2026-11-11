import type {
  EstimateSource,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import type { EstimateEvent } from "./usageEstimate.ts";

export interface SubscriptionUsageSource {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId?: string;
  readonly instanceIds: readonly string[];
  readonly records: readonly UsageRecord[];
  /** Optional search locations that do not exist are not gaps in a readable history. */
  readonly missing?: boolean;
  readonly incomplete: boolean;
}

const DRIVER_USAGE: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
  antigravity: "antigravity",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  muse: "muse",
  pi: "pi",
};
const LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode Go",
  muse: "Muse",
  pi: "Pi",
  devin: "Devin",
};

type SubscriptionProvider = Pick<
  ServerProvider,
  "driver" | "instanceId" | "enabled" | "installed" | "auth" | "usageLimits"
>;

/** Identity follows the login, not a user-editable display name or an API key. */
function accountKey(provider: SubscriptionProvider) {
  return JSON.stringify([
    provider.auth.email?.trim().toLowerCase() ?? null,
    provider.usageLimits?.credentialFingerprint ?? null,
    provider.auth.workspaceId ?? null,
    provider.auth.email || provider.usageLimits?.credentialFingerprint ? null : provider.instanceId,
  ]);
}

/** Undefined means this bucket's model membership is not available in the native history. */
function belongsToWindow(
  provider: string,
  window: ServerProviderUsageWindow,
  record: UsageRecord,
): boolean | undefined {
  const model = record.model.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (provider === "antigravity") {
    if (window.id.startsWith("gemini-argon-")) return model.includes("argon");
    if (window.id.startsWith("gemini-"))
      return model.includes("gemini") && !model.includes("argon");
    if (window.id.startsWith("3p-")) return /claude|gpt|openai/.test(model);
    if (window.id.startsWith("claude-")) return model.includes("claude");
    if (window.id.startsWith("gpt-")) return /gpt|openai/.test(model);
    return undefined;
  }
  if (provider === "claude" && window.id !== "five_hour" && window.id !== "seven_day") {
    if (!window.id.startsWith("seven_day_")) return undefined;
    return model.includes(window.id.slice("seven_day_".length).replaceAll("_", "-"));
  }
  if (provider === "cursor") {
    if (record.billingProvider === "api") return false;
    // Cursor models can spill into the other pool; model name alone cannot allocate them.
    if (record.billingProvider === "cursor-models")
      return window.id === "totalPercentUsed" || window.id === "autoPercentUsed";
    if (record.billingProvider === "other-models")
      return window.id === "totalPercentUsed" || window.id === "apiPercentUsed";
    return undefined;
  }
  if (provider === "opencode")
    return record.billingProvider ? record.billingProvider === "opencode-go" : undefined;
  return true;
}

/** Build per-login, per-window batches from existing readers and already-probed limits. No new polling. */
export function subscriptionEstimateSources(
  providers: readonly SubscriptionProvider[],
  sources: readonly SubscriptionUsageSource[],
  hostId: string,
) {
  return providers.flatMap((provider) => {
    const limits = provider.usageLimits;
    if (!provider.enabled || !provider.installed || !limits || limits.unavailable) return [];
    const usageProvider = limits.provider?.id ?? DRIVER_USAGE[provider.driver];
    if (!usageProvider) return [];
    const checkedAtMs = Date.parse(limits.checkedAt);
    const candidates = sources.filter(
      (source) =>
        !source.missing &&
        source.provider === usageProvider &&
        source.instanceIds.includes(provider.instanceId),
    );
    const login = accountKey(provider);
    const ambiguous = candidates.some((source) =>
      source.instanceIds.some((id) =>
        providers.some(
          (other) =>
            other.instanceId === id &&
            other.enabled &&
            other.usageLimits &&
            !other.usageLimits.unavailable &&
            accountKey(other) !== login,
        ),
      ),
    );
    return limits.windows.flatMap((window) => {
      // Existing Codex weekly history stays on its original immutable ledger identity.
      if (provider.driver === "codex" && window.kind === "weekly") return [];
      const reset = Date.parse(window.resetsAt ?? "");
      const start = Date.parse(window.startsAt ?? "");
      const duration = window.windowDurationMins ?? (window.kind === "weekly" ? 10080 : 0);
      const cycleStart =
        Number.isFinite(start) && start < reset
          ? start
          : Number.isFinite(reset) && duration > 0
            ? reset - duration * 60_000
            : undefined;
      const blockers = new Set<string>();
      if (ambiguous) blockers.add("account_ambiguous");
      if (candidates.length === 0) blockers.add("usage_unavailable");
      if (candidates.some((source) => source.incomplete)) blockers.add("usage_incomplete");
      const source: EstimateSource = {
        id: JSON.stringify([
          "subscription",
          hostId,
          provider.driver,
          login,
          provider.instanceId,
          window.id,
          candidates
            .map((entry) => [entry.dir, entry.volumeId])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]),
        deviceId: hostId,
        accountId:
          provider.auth.email?.trim().toLowerCase() || limits.credentialFingerprint || null,
        coverage: candidates.some((entry) => entry.hostId && entry.hostId !== hostId)
          ? "account"
          : "device",
        scope: {
          driver: provider.driver,
          provider: usageProvider,
          providerLabel: LABELS[usageProvider] ?? limits.provider?.label ?? usageProvider,
          instanceId: provider.instanceId,
          accountKey: login,
          ...(provider.auth.workspaceId ? { workspaceId: provider.auth.workspaceId } : {}),
          windowId: window.id,
          windowLabel: window.label,
        },
      };
      const events: EstimateEvent[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const occurrences = new Map<string, number>();
        for (const record of candidate.records) {
          if (
            record.timestampMs > checkedAtMs ||
            (cycleStart !== undefined && record.timestampMs < cycleStart)
          )
            continue;
          const belongs = belongsToWindow(usageProvider, window, record);
          if (belongs === undefined) {
            blockers.add("quota_scope_unknown");
            continue;
          }
          if (!belongs) continue;
          if (record.unresolvedServiceTierTurnId) {
            blockers.add("speed_unconfirmed");
            continue;
          }
          const key =
            record.dedupeKey ??
            JSON.stringify([
              candidate.dir,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
          const occurrence = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occurrence);
          const id = record.dedupeKey ?? `${key}:${occurrence}`;
          if (seen.has(id)) continue;
          seen.add(id);
          events.push({
            kind: "usage",
            id,
            timestampMs: record.timestampMs,
            sessionId: record.sessionId || id,
            model: record.model,
            ...(record.rateModel ? { rateModel: record.rateModel } : {}),
            totals: record.totals,
            speed: record.speed,
            speedKnown: true,
          });
        }
      }
      const quota = {
        kind: "quota" as const,
        sessionId: provider.instanceId,
        timestampMs: checkedAtMs,
        usedPercent: window.usedPercent,
        windowMinutes: duration,
        resetsAtMs: Number.isFinite(reset) ? reset : 0,
        limitId: window.id,
        plan: provider.usageLimits?.subscription?.plan ?? provider.auth.label ?? null,
        origin: "account_probe" as const,
        ...(Number.isFinite(start) && start < reset ? { startsAtMs: start } : {}),
      };
      events.push({ ...quota, id: JSON.stringify(["probe", quota]) });
      return [
        {
          source,
          events,
          path: candidates.map((candidate) => candidate.dir).join(" · "),
          blockers: [...blockers],
        },
      ];
    });
  });
}
