import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageProviderKind,
} from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import {
  subscriptionEstimateSources,
  type SubscriptionUsageSource,
} from "./subscriptionEstimateSources.ts";
import { estimateUsageCycle, selectUsageEstimateCycleSamples } from "./usageEstimate.ts";

const now = Date.parse("2026-11-11T06:00:00Z");
const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const window: ServerProviderUsageWindow = {
  id: "daily",
  kind: "other",
  label: "Daily",
  usedPercent: 100,
  windowDurationMins: 1440,
  resetsAt: iso(now + 3600000),
};
const provider = (
  driver: string,
  windows: readonly ServerProviderUsageWindow[] = [window],
  vendor = driver,
): ServerProvider => ({
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  checkedAt: iso(now),
  models: [],
  slashCommands: [],
  skills: [],
  auth: { status: "authenticated", email: "a@example.com" },
  usageLimits: { checkedAt: iso(now), provider: { id: vendor, label: vendor }, windows },
});
const usage = (
  kind: UsageProviderKind,
  model = "fixture-model",
  timestampMs = now - 1000,
): UsageRecord => ({
  provider: kind,
  model,
  sessionId: "s",
  timestampMs,
  totals: {
    uncachedInputTokens: 75,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: null,
});
const source = (
  kind: UsageProviderKind,
  instance: string,
  records = [usage(kind)],
): SubscriptionUsageSource => ({
  provider: kind,
  dir: `/${kind}`,
  volumeId: "disk",
  instanceIds: [instance],
  records,
  incomplete: false,
});
const pricing = {
  id: "rates",
  description: "test",
  rates: {
    "fixture-model": {
      inputCostPerToken: 1,
      outputCostPerToken: 1,
      cacheReadCostPerToken: 0,
      cacheCreationCostPerToken: 1,
      fast: null,
      ultrafast: null,
    },
  },
};

describe("provider subscription observations", () => {
  it("retains the quota probe's confirmed plan even when ACP enrichment omits the auth label", () => {
    const p = provider("acpRegistry", [window], "devin");
    const confirmed = { ...p, usageLimits: { ...p.usageLimits!, subscription: { plan: "Pro" } } };
    const [batch] = subscriptionEstimateSources(
      [confirmed],
      [source("devin", "acpRegistry")],
      "device",
    );
    expect(batch?.events.find((event) => event.kind === "quota")).toMatchObject({ plan: "Pro" });
  });
  it("ignores absent optional history locations while retaining failures in existing histories", () => {
    const active = source("antigravity", "antigravity", [usage("antigravity", "gemini-4-pro")]);
    const absent = {
      ...active,
      dir: "/not-installed",
      records: [],
      incomplete: true,
      missing: true,
    };
    const p = provider("antigravity", [{ ...window, id: "gemini-weekly" }]);
    const [batch] = subscriptionEstimateSources([p], [active, absent], "device");
    expect(batch?.blockers).toEqual([]);
    expect(batch?.path).toBe(active.dir);
    const [failed] = subscriptionEstimateSources(
      [p],
      [active, { ...absent, missing: false }],
      "device",
    );
    expect(failed?.blockers).toContain("usage_incomplete");
  });
  it.each([
    ["acpRegistry", "devin", "daily"],
    ["claudeAgent", "claude", "five_hour"],
    ["grok", "grok", "subscription"],
    ["muse", "muse", "weekly"],
    ["codex", "codex", "session"],
  ] as const)("estimates an exhausted %s window from its own cycle", (driver, vendor, id) => {
    const [batch] = subscriptionEstimateSources(
      [provider(driver, [{ ...window, id }], vendor)],
      [source(vendor, driver)],
      "device",
    );
    expect(batch?.blockers).toEqual([]);
    const bounds = selectUsageEstimateCycleSamples(batch!.events, batch!.source).at(-1)!;
    expect(estimateUsageCycle(batch!.source, batch!.events, pricing, bounds)).toMatchObject({
      status: "reference_only",
      costUsd: 75,
      cycleEquivalentUsd: 75,
      remainingEquivalentUsd: 0,
    });
  });
  it("splits Antigravity model pools and uses the whole matching cycle only", () => {
    const windows = ["gemini-weekly", "gemini-argon-weekly", "3p-weekly"].map((id) => ({
      ...window,
      id,
    }));
    const records = [
      usage("antigravity", "gemini-4-pro"),
      usage("antigravity", "gemini-4-argon"),
      usage("antigravity", "claude-fable-5.2"),
      usage("antigravity", "gpt-6.1-sol"),
      usage("antigravity", "gemini-4-pro", now - 2 * 86400000),
      usage("antigravity", "gemini-4-pro", now + 1),
    ];
    const batches = subscriptionEstimateSources(
      [provider("antigravity", windows)],
      [source("antigravity", "antigravity", records)],
      "device",
    );
    expect(
      batches.map((b) => b.events.filter((e) => e.kind === "usage").map((e) => e.model)),
    ).toEqual([["gemini-4-pro"], ["gemini-4-argon"], ["claude-fable-5.2", "gpt-6.1-sol"]]);
  });
  it("keeps login identities separate and refuses shared history with ambiguous accounts", () => {
    const a = provider("claudeAgent", [{ ...window, id: "five_hour" }], "claude");
    const b = {
      ...a,
      instanceId: ProviderInstanceId.make("claude-b"),
      auth: { ...a.auth, email: "b@example.com" },
    };
    const shared = {
      ...source("claude", "claudeAgent"),
      instanceIds: [a.instanceId, b.instanceId],
    };
    const batches = subscriptionEstimateSources([a, b], [shared], "device");
    expect(batches[0]?.source.id).not.toEqual(batches[1]?.source.id);
    expect(batches.map((b) => b.blockers)).toEqual([["account_ambiguous"], ["account_ambiguous"]]);
    expect(
      subscriptionEstimateSources(
        [a, b],
        [source("claude", a.instanceId), { ...source("claude", b.instanceId), dir: "/other" }],
        "device",
      ).every((b) => b.blockers.length === 0),
    ).toBe(true);
  });
  it("uses OpenCode Go requests and excludes directly billed providers", () => {
    const records = [
      { ...usage("opencode"), billingProvider: "opencode-go" },
      { ...usage("opencode", "api-model"), billingProvider: "openai" },
    ];
    const [batch] = subscriptionEstimateSources(
      [provider("opencode")],
      [source("opencode", "opencode", records)],
      "device",
    );
    expect(batch?.events.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(batch?.blockers).toEqual([]);
  });
  it("does not invent a monthly start, an API price, or a reset timestamp", () => {
    const { windowDurationMins: _, ...monthly } = window;
    const [batch] = subscriptionEstimateSources(
      [provider("grok", [{ ...monthly, kind: "monthly" }])],
      [source("grok", "grok")],
      "device",
    );
    expect(selectUsageEstimateCycleSamples(batch!.events, batch!.source)[0]).toMatchObject({
      basis: "interval",
      fromMs: now,
    });
    const { resetsAt: __, ...noReset } = monthly;
    const [missing] = subscriptionEstimateSources([provider("grok", [noReset])], [], "device");
    expect(missing?.blockers).toContain("usage_unavailable");
    expect(missing?.events.at(-1)).toMatchObject({ resetsAtMs: 0 });
  });
  it("does not add duplicate requests, and surfaces incomplete scans without manufacturing zero cost", () => {
    const row = { ...usage("devin"), dedupeKey: "request" };
    const input = { ...source("devin", "acpRegistry", [row, row]), incomplete: true };
    const [batch] = subscriptionEstimateSources(
      [provider("acpRegistry", [window], "devin")],
      [input],
      "device",
    );
    expect(batch?.events.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(batch?.blockers).toEqual(["usage_incomplete"]);
  });
  it("marks Cursor account history and refuses unallocated model subpools", () => {
    const windows = ["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"].map((id) => ({
      ...window,
      id,
      kind: "monthly" as const,
    }));
    const batches = subscriptionEstimateSources(
      [provider("cursor", windows)],
      [{ ...source("cursor", "cursor"), hostId: "cursor.com" }],
      "device",
    );
    expect(batches.every((b) => b.source.coverage === "account")).toBe(true);
    expect(batches.slice(1).every((b) => b.blockers.includes("quota_scope_unknown"))).toBe(true);
  });
});
