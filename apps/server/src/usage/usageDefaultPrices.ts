import type { ModelRate, RateTable, TokenRates } from "./usagePricing.ts";

/** Bump when a sourced rule changes; persisted estimates keep the previous rule snapshot. */
export const DEFAULT_PRICE_REVISION = "2026-11-11.1";
const GOOGLE_PRICES = "https://ai.google.dev/gemini-api/docs/pricing";
const DEVIN_PRICES = "https://docs.devin.ai/desktop/models";
const DECEMBER = Date.parse("2026-12-01T08:00:00Z");

const tokens = (input: number, output: number, read: number, write = input): TokenRates => ({
  inputCostPerToken: input / 1_000_000,
  outputCostPerToken: output / 1_000_000,
  cacheReadCostPerToken: read / 1_000_000,
  cacheCreationCostPerToken: write / 1_000_000,
});

/** Public standard token rates, with time-bounded quota exemptions kept separate from API value. */
export const DEFAULT_MODEL_PRICES: ReadonlyArray<{
  model: string;
  source: string;
  rate: ModelRate;
}> = [
  ...["gemini-4-argon", "gemini-4-carbon"].map((model) => ({
    model,
    source: GOOGLE_PRICES,
    rate: {
      ...tokens(4, 20, 0.2),
      fast: tokens(7.2, 36, 0.36),
      ultrafast: null,
      introductory: { untilMs: DECEMBER, ...tokens(2, 10, 0.1), fast: tokens(3.6, 18, 0.18) },
    },
  })),
  {
    model: "swe-2",
    source: DEVIN_PRICES,
    rate: {
      ...tokens(3, 15, 0.3),
      fast: null,
      ultrafast: null,
      quotaFree: { provider: "devin", plans: ["free", "pro", "max", "teams"], untilMs: DECEMBER },
    },
  },
  {
    model: "swe-2-flash",
    source: DEVIN_PRICES,
    rate: {
      ...tokens(0.1, 0.5, 0.01, 0.125),
      fast: null,
      ultrafast: null,
      quotaFree: {
        provider: "devin",
        plans: ["free", "pro", "max", "teams"],
        untilMs: Date.parse("2026-12-04T18:00:00Z"),
      },
    },
  },
];

/** Official rules cover gaps offline and supersede stale aggregate rates for these exact models. */
export function withDefaultPrices(table: RateTable): RateTable {
  const result = new Map(table);
  for (const entry of DEFAULT_MODEL_PRICES) {
    result.set(entry.model, entry.rate);
    if (entry.model.startsWith("gemini-")) result.set(`gemini/${entry.model}`, entry.rate);
  }
  return result;
}
