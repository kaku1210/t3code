import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as UsageEstimateStore from "./UsageEstimateStore.ts";

const source = { id: "origin-a", deviceId: "device-a", accountId: "account-a", coverage: "device" };
const start = Date.parse("2026-11-09T00:00:00Z");
const end = start + 3_600_000;
const events = [
  {
    id: "q0",
    kind: "quota",
    sessionId: "session",
    timestampMs: start,
    usedPercent: 15,
    windowMinutes: 10_080,
    resetsAtMs: start + 604_800_000,
    limitId: "codex",
    plan: "test",
    origin: "account_probe",
  },
  {
    id: "u1",
    kind: "usage",
    sessionId: "session",
    timestampMs: end,
    model: "fixture-model",
    totals: {
      uncachedInputTokens: 75,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    speed: "standard",
    speedKnown: true,
  },
  {
    id: "q1",
    kind: "quota",
    sessionId: "session",
    timestampMs: end,
    usedPercent: 20,
    windowMinutes: 10_080,
    resetsAtMs: start + 604_800_000,
    limitId: "codex",
    plan: "test",
    origin: "account_probe",
  },
];
const pricing = {
  id: "price-a",
  description: "Test prices",
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
const range = { sourceId: source.id, pricingId: pricing.id, fromMs: start, untilMs: end };

it.effect(
  "publishes automatic series idempotently, freezes historical prices and separates cycle resets",
  () =>
    Effect.gen(function* () {
      const store = yield* UsageEstimateStore.UsageEstimateStore;
      yield* store.ingest({ source, events });
      yield* store.savePricing(pricing);
      const input = {
        sources: [{ id: source.id, path: "/test/codex" }],
        pricingId: pricing.id,
        nowMs: end,
      };
      const [first] = yield* store.readSeries(input);
      expect(first?.current?.result.basis).toBe("cycle_to_date");
      expect(first?.current?.result.cycleEquivalentUsd).toBe(375);
      expect(first?.current?.result.remainingEquivalentUsd).toBe(300);
      expect(first?.history.map((point) => point.cycleEquivalentUsd)).toEqual([null, 375]);
      expect(yield* store.readSeries(input)).toEqual([first]);
      const count = (yield* store.history(source.id)).length;
      yield* store.readSeries(input);
      expect((yield* store.history(source.id)).length).toBe(count);
      const changed = {
        ...pricing,
        id: "new-price",
        rates: { "fixture-model": { ...pricing.rates["fixture-model"], inputCostPerToken: 2 } },
      };
      yield* store.savePricing(changed);
      const [repriced] = yield* store.readSeries({ ...input, pricingId: changed.id });
      expect(repriced?.current?.result.cycleEquivalentUsd).toBe(750);
      expect(repriced?.history).toEqual(first?.history);
      const [withoutPrices] = yield* store.readSeries({ ...input, pricingId: null });
      expect(withoutPrices?.current).toBeNull();
      expect(withoutPrices?.history).toEqual(first?.history);
      const reset = end + 1000;
      yield* store.ingest({
        source,
        events: [
          {
            ...events[2],
            id: "reset",
            usedPercent: 0,
            timestampMs: reset,
            resetsAtMs: reset + 604800000,
          },
        ],
      });
      const [next] = yield* store.readSeries({ ...input, nowMs: reset });
      expect(next?.current?.result.status).toBe("collecting");
      expect(next?.current?.segmentStartMs).toBe(reset);
      expect(next?.history.slice(0, 2)).toEqual(first?.history);
      expect(next?.history.at(-1)?.cycleEquivalentUsd).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.provide(UsageEstimateStore.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
      Effect.scoped,
    ),
);

it.effect("clears temporary reader failures on refresh without rewriting a saved observation", () =>
  Effect.gen(function* () {
    const store = yield* UsageEstimateStore.UsageEstimateStore;
    yield* store.ingest({ source, events });
    yield* store.savePricing(pricing);
    const input = {
      sources: [{ id: source.id, path: "/test", blockers: ["usage_incomplete"] }],
      pricingId: pricing.id,
      nowMs: end,
    };
    const [failed] = yield* store.readSeries(input);
    expect(failed?.current?.result.status).toBe("blocked");
    const [recovered] = yield* store.readSeries({
      ...input,
      sources: [{ id: source.id, path: "/test" }],
    });
    expect(recovered?.current?.result.cycleEquivalentUsd).toBe(375);
    expect(recovered?.history).toEqual(failed?.history);
  }).pipe(
    Effect.provide(
      Layer.provide(UsageEstimateStore.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
    Effect.scoped,
  ),
);

it.effect(
  "persists across reopen, deduplicates downloaded origin data, and freezes old prices",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-estimate-" });
      const database = path.join(directory, "usage.sqlite");
      const first = yield* Effect.gen(function* () {
        const store = yield* UsageEstimateStore.UsageEstimateStore;
        expect(yield* store.ingest({ source, events })).toEqual({ inserted: 3, revision: 1 });
        yield* store.savePricing(pricing);
        return yield* store.evaluate(range);
      }).pipe(
        Effect.provide(
          Layer.provide(UsageEstimateStore.layer, NodeSqliteClient.layer({ filename: database })),
        ),
        Effect.scoped,
      );
      yield* Effect.gen(function* () {
        const store = yield* UsageEstimateStore.UsageEstimateStore;
        expect(yield* store.ingest({ source, events })).toEqual({ inserted: 0, revision: 1 });
        expect(
          yield* store.ingest({
            source: Object.fromEntries(Object.entries(source).reverse()),
            events: events.map((event) => Object.fromEntries(Object.entries(event).reverse())),
          }),
        ).toEqual({ inserted: 0, revision: 1 });
        expect(yield* store.evaluate(range)).toEqual(first);
        const changed = {
          ...pricing,
          id: "price-b",
          rates: { "fixture-model": { ...pricing.rates["fixture-model"], inputCostPerToken: 2 } },
        };
        yield* store.savePricing(changed);
        expect(
          (yield* store.evaluate({ ...range, pricingId: changed.id })).result.cycleEquivalentUsd,
        ).toBe(3000);
        expect(
          (yield* store.history(source.id))
            .map((item) => item.result.cycleEquivalentUsd)
            .toSorted(),
        ).toEqual([1500, 3000]);
        expect(
          (yield* Effect.flip(store.savePricing({ ...changed, id: pricing.id }))).operation,
        ).toBe("pricing");
      }).pipe(
        Effect.provide(
          Layer.provide(UsageEstimateStore.layer, NodeSqliteClient.layer({ filename: database })),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rejects identity and event conflicts atomically while keeping devices separate", () =>
  Effect.gen(function* () {
    const store = yield* UsageEstimateStore.UsageEstimateStore;
    yield* store.ingest({ source, events });
    const conflict = { ...events[0], usedPercent: 99 };
    yield* Effect.flip(
      store.ingest({ source, events: [{ ...events[1], id: "must-rollback" }, conflict] }),
    );
    expect(
      yield* store.ingest({ source, events: [{ ...events[1], id: "must-rollback" }] }),
    ).toEqual({ inserted: 1, revision: 2 });
    yield* Effect.flip(
      store.ingest({ source: { ...source, deviceId: "different-device" }, events }),
    );
    yield* Effect.flip(
      store.ingest({ source: { ...source, accountId: "different-account" }, events }),
    );
    expect(
      yield* store.ingest({ source: { ...source, id: "origin-b", deviceId: "device-b" }, events }),
    ).toEqual({ inserted: 3, revision: 1 });
    expect(yield* store.ingest({ source, events })).toEqual({ inserted: 0, revision: 2 });
  }).pipe(
    Effect.provide(
      Layer.provide(UsageEstimateStore.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

it.effect("refuses an unrelated database before creating estimate tables", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE unrelated_data (value TEXT)`;
    yield* sql`INSERT INTO unrelated_data VALUES ('keep')`;
    const error = yield* Effect.flip(
      Effect.asVoid(UsageEstimateStore.UsageEstimateStore).pipe(
        Effect.provide(UsageEstimateStore.layer),
      ),
    );
    expect(error.operation).toBe("initialize");
    expect(yield* sql`SELECT * FROM unrelated_data`).toEqual([{ value: "keep" }]);
    expect(yield* sql`SELECT name FROM sqlite_schema WHERE name='usage_estimate_meta'`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "migrates the replay database and keeps the runtime connection separate from main state",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-estimate-runtime-" });
      const database = path.join(directory, UsageEstimateStore.DATABASE_FILE_NAME);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE usage_estimate_meta (version INTEGER NOT NULL)`;
        yield* sql`INSERT INTO usage_estimate_meta VALUES (1)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })), Effect.scoped);
      const main = yield* SqlClient.SqlClient;
      yield* main`CREATE TABLE main_state (value TEXT)`;
      yield* main`INSERT INTO main_state VALUES ('preserved')`;
      const identity = yield* Effect.gen(function* () {
        const store = yield* UsageEstimateStore.UsageEstimateStore;
        yield* store.ingest({ source, events });
        yield* store.savePricing(pricing);
        expect((yield* store.evaluate(range)).result.cycleEquivalentUsd).toBe(1500);
        expect(yield* main`SELECT * FROM main_state`).toEqual([{ value: "preserved" }]);
        expect(
          yield* main`SELECT name FROM sqlite_schema WHERE name='usage_estimate_events'`,
        ).toEqual([]);
        return store.databaseId;
      }).pipe(Effect.provide(UsageEstimateStore.layerLocal(directory)), Effect.scoped);
      yield* Effect.gen(function* () {
        const store = yield* UsageEstimateStore.UsageEstimateStore;
        expect(store.databaseId).toBe(identity);
        expect(yield* store.ingest({ source, events })).toEqual({ inserted: 0, revision: 1 });
        expect((yield* store.history(source.id))[0]?.result.cycleEquivalentUsd).toBe(1500);
      }).pipe(Effect.provide(UsageEstimateStore.layerLocal(directory)), Effect.scoped);
    }).pipe(
      Effect.provide(
        Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
      Effect.scoped,
    ),
);
