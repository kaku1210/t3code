import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeUtil from "node:util";
import { USAGE_ESTIMATE_RESET_TOLERANCE_MS } from "@t3tools/shared/usageEstimates";
import {
  EstimateSource,
  UsageIntervalEstimate,
  SavedUsageEstimate,
  type UsageEstimateSeries,
} from "@t3tools/contracts";

import {
  EstimateEvent,
  EstimatePricing,
  estimateUsageInterval,
  estimateUsageCycle,
  selectUsageEstimateCycleSamples,
} from "./usageEstimate.ts";

export class UsageEstimateStoreError extends Schema.TaggedError<UsageEstimateStoreError>()(
  "UsageEstimateStoreError",
  {
    operation: Schema.Literals([
      "initialize",
      "ingest",
      "pricing",
      "evaluate",
      "history",
      "series",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Local usage estimate storage failed during ${this.operation}.`;
  }
}

const Batch = Schema.Struct({ source: EstimateSource, events: Schema.Array(EstimateEvent) });
const Range = Schema.Struct({
  sourceId: Schema.String,
  pricingId: Schema.String,
  fromMs: Schema.Finite,
  untilMs: Schema.Finite,
}).check(Schema.makeFilter((range) => range.fromMs >= 0 && range.untilMs >= range.fromMs));

const SeriesInput = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      blockers: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  pricingId: Schema.NullOr(Schema.String),
  nowMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeSeriesInput = Schema.decodeUnknownEffect(SeriesInput);

const decodeBatch = Schema.decodeUnknownEffect(Batch);
const decodeRange = Schema.decodeUnknownEffect(Range);
const decodePricing = Schema.decodeUnknownEffect(EstimatePricing);
const decodeResult = Schema.decodeUnknownEffect(UsageIntervalEstimate);
const decodeSavedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedUsageEstimate));
const decodeSourceJson = Schema.decodeUnknownEffect(Schema.fromJsonString(EstimateSource));
const decodePricingJson = Schema.decodeUnknownEffect(Schema.fromJsonString(EstimatePricing));
const decodeEventJson = Schema.decodeUnknownEffect(Schema.fromJsonString(EstimateEvent));
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(EstimateSource));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(EstimateEvent));
const encodePricing = Schema.encodeEffect(Schema.fromJsonString(EstimatePricing));
const encodeSaved = Schema.encodeEffect(Schema.fromJsonString(SavedUsageEstimate));
const encodeId = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
);

class UsageEstimateIntegrityError extends Schema.TaggedError<UsageEstimateIntegrityError>()(
  "UsageEstimateIntegrityError",
  {
    reason: Schema.Literals([
      "foreign_database",
      "unsupported_version",
      "identity_conflict",
      "event_conflict",
      "price_conflict",
      "missing_input",
    ]),
  },
) {
  override get message() {
    return `Local usage estimate integrity check failed: ${this.reason}.`;
  }
}

/** Dedicated local ledger; all imports, including future remote downloads, pass the same transaction. */
export class UsageEstimateStore extends Context.Service<
  UsageEstimateStore,
  {
    readonly databaseId: string;
    readonly ingest: (
      batch: unknown,
    ) => Effect.Effect<{ inserted: number; revision: number }, UsageEstimateStoreError>;
    readonly savePricing: (pricing: unknown) => Effect.Effect<void, UsageEstimateStoreError>;
    readonly evaluate: (
      range: unknown,
    ) => Effect.Effect<SavedUsageEstimate, UsageEstimateStoreError>;
    readonly history: (
      sourceId: string,
    ) => Effect.Effect<readonly SavedUsageEstimate[], UsageEstimateStoreError>;
    readonly readSeries: (
      input: unknown,
    ) => Effect.Effect<readonly UsageEstimateSeries[], UsageEstimateStoreError>;
  }
>()("t3/usage/UsageEstimateStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databaseId = yield* Effect.gen(function* () {
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
    if (tables.length > 0 && !tables.some((table) => table.name === "usage_estimate_meta")) {
      return yield* new UsageEstimateIntegrityError({ reason: "foreign_database" });
    }
    yield* sql`CREATE TABLE IF NOT EXISTS usage_estimate_meta (version INTEGER NOT NULL, database_id TEXT NOT NULL)`;
    const versions = yield* sql<{ version: number }>`SELECT version FROM usage_estimate_meta`;
    if (versions.length === 0)
      yield* sql`INSERT INTO usage_estimate_meta VALUES (2,lower(hex(randomblob(16))))`;
    else if (versions.length === 1 && versions[0]?.version === 1) {
      yield* sql`ALTER TABLE usage_estimate_meta ADD COLUMN database_id TEXT`;
      yield* sql`UPDATE usage_estimate_meta SET version=2,database_id=lower(hex(randomblob(16)))`;
    } else if (versions.length !== 1 || versions[0]?.version !== 2)
      return yield* new UsageEstimateIntegrityError({ reason: "unsupported_version" });
    const [identity] = yield* sql<{
      database_id: string;
    }>`SELECT database_id FROM usage_estimate_meta`;
    if (!identity || typeof identity.database_id !== "string" || identity.database_id.length === 0)
      return yield* new UsageEstimateIntegrityError({ reason: "missing_input" });
    yield* sql`CREATE TABLE IF NOT EXISTS usage_estimate_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS usage_estimate_events (source_id TEXT NOT NULL, id TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_id,id))`;
    yield* sql`CREATE INDEX IF NOT EXISTS usage_estimate_event_range ON usage_estimate_events(source_id,timestamp_ms)`;
    yield* sql`CREATE TABLE IF NOT EXISTS usage_estimate_prices (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS usage_estimate_results (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, computed_at_ms INTEGER NOT NULL, payload TEXT NOT NULL)`;
    yield* sql`CREATE INDEX IF NOT EXISTS usage_estimate_result_source ON usage_estimate_results(source_id,computed_at_ms)`;
    return identity.database_id;
  }).pipe(
    sql.withTransaction,
    Effect.mapError((cause) => new UsageEstimateStoreError({ operation: "initialize", cause })),
  );

  const ingest = Effect.fn("UsageEstimateStore.ingest")(
    function* (input: unknown) {
      const batch = yield* decodeBatch(input);
      const encodedSource = yield* encodeSource(batch.source);
      const sources = yield* sql<{
        payload: string;
        revision: number;
      }>`SELECT payload,revision FROM usage_estimate_sources WHERE id=${batch.source.id}`;
      const source = sources[0];
      if (
        source &&
        !NodeUtil.isDeepStrictEqual(yield* decodeSourceJson(source.payload), batch.source)
      )
        return yield* new UsageEstimateIntegrityError({ reason: "identity_conflict" });
      const revision = source?.revision ?? 0;
      if (!source)
        yield* sql`INSERT INTO usage_estimate_sources VALUES (${batch.source.id},${encodedSource},0)`;
      let inserted = 0;
      for (const event of batch.events) {
        const payload = yield* encodeEvent(event);
        const existing = yield* sql<{
          payload: string;
        }>`SELECT payload FROM usage_estimate_events WHERE source_id=${batch.source.id} AND id=${event.id}`;
        if (existing[0]) {
          if (!NodeUtil.isDeepStrictEqual(yield* decodeEventJson(existing[0].payload), event))
            return yield* new UsageEstimateIntegrityError({ reason: "event_conflict" });
          continue;
        }
        yield* sql`INSERT INTO usage_estimate_events VALUES (${batch.source.id},${event.id},${event.timestampMs},${revision + 1},${payload})`;
        inserted++;
      }
      if (inserted > 0)
        yield* sql`UPDATE usage_estimate_sources SET revision=${revision + 1} WHERE id=${batch.source.id}`;
      return { inserted, revision: revision + (inserted > 0 ? 1 : 0) };
    },
    sql.withTransaction,
    Effect.mapError((cause) => new UsageEstimateStoreError({ operation: "ingest", cause })),
  );

  const savePricing = Effect.fn("UsageEstimateStore.savePricing")(
    function* (input: unknown) {
      const pricing = yield* decodePricing(input);
      const payload = yield* encodePricing({
        ...pricing,
        rates: Object.fromEntries(
          Object.entries(pricing.rates).sort(([a], [b]) => a.localeCompare(b)),
        ),
      });
      const previous = yield* sql<{
        payload: string;
      }>`SELECT payload FROM usage_estimate_prices WHERE id=${pricing.id}`;
      if (previous[0]) {
        if (!NodeUtil.isDeepStrictEqual(yield* decodePricingJson(previous[0].payload), pricing))
          return yield* new UsageEstimateIntegrityError({ reason: "price_conflict" });
      } else yield* sql`INSERT INTO usage_estimate_prices VALUES (${pricing.id},${payload})`;
    },
    sql.withTransaction,
    Effect.mapError((cause) => new UsageEstimateStoreError({ operation: "pricing", cause })),
  );

  const evaluate = Effect.fn("UsageEstimateStore.evaluate")(
    function* (input: unknown) {
      const range = yield* decodeRange(input);
      const [sourceRow] = yield* sql<{
        payload: string;
        revision: number;
      }>`SELECT payload,revision FROM usage_estimate_sources WHERE id=${range.sourceId}`;
      const [pricingRow] = yield* sql<{
        payload: string;
      }>`SELECT payload FROM usage_estimate_prices WHERE id=${range.pricingId}`;
      if (!sourceRow || !pricingRow)
        return yield* new UsageEstimateIntegrityError({ reason: "missing_input" });
      const id = yield* encodeId([
        range.sourceId,
        sourceRow.revision,
        range.fromMs,
        range.untilMs,
        range.pricingId,
        1,
      ]);
      const [previous] = yield* sql<{
        payload: string;
      }>`SELECT payload FROM usage_estimate_results WHERE id=${id}`;
      if (previous) return yield* decodeSavedJson(previous.payload);
      const source = yield* decodeSourceJson(sourceRow.payload);
      const pricing = yield* decodePricingJson(pricingRow.payload);
      const rows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM usage_estimate_events WHERE source_id=${range.sourceId} AND timestamp_ms>=${range.fromMs} AND timestamp_ms<=${range.untilMs} ORDER BY timestamp_ms,id`;
      const events = yield* Effect.forEach(rows, (row) => decodeEventJson(row.payload));
      const result = yield* decodeResult(estimateUsageInterval(source, events, pricing, range));
      const saved: SavedUsageEstimate = {
        id,
        revision: sourceRow.revision,
        computedAtMs: yield* Clock.currentTimeMillis,
        result,
      };
      const payload = yield* encodeSaved(saved);
      yield* sql`INSERT INTO usage_estimate_results VALUES (${id},${range.sourceId},${saved.computedAtMs},${payload})`;
      return saved;
    },
    sql.withTransaction,
    Effect.mapError((cause) => new UsageEstimateStoreError({ operation: "evaluate", cause })),
  );

  const history = Effect.fn("UsageEstimateStore.history")(
    function* (sourceId: string) {
      const rows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM usage_estimate_results WHERE source_id=${sourceId} ORDER BY computed_at_ms,id`;
      return yield* Effect.forEach(rows, (row) => decodeSavedJson(row.payload));
    },
    Effect.mapError((cause) => new UsageEstimateStoreError({ operation: "history", cause })),
  );
  const readSeries = Effect.fn("UsageEstimateStore.readSeries")(
    function* (raw: unknown) {
      const input = yield* decodeSeriesInput(raw);
      const cutoff = Math.max(0, input.nowMs - 92 * 86400000);
      const pricingRows =
        input.pricingId === null
          ? []
          : yield* sql<{
              payload: string;
            }>`SELECT payload FROM usage_estimate_prices WHERE id=${input.pricingId}`;
      const pricing = pricingRows[0] ? yield* decodePricingJson(pricingRows[0].payload) : null;
      const series: UsageEstimateSeries[] = [];
      for (const origin of input.sources) {
        const [row] = yield* sql<{
          payload: string;
          revision: number;
        }>`SELECT payload,revision FROM usage_estimate_sources WHERE id=${origin.id}`;
        if (!row) continue;
        const source = yield* decodeSourceJson(row.payload);
        const stored = yield* sql<{
          payload: string;
        }>`SELECT payload FROM usage_estimate_results WHERE source_id=${origin.id} AND id LIKE 'automatic:%' AND json_extract(payload,'$.sampledAtMs')>=${cutoff} AND json_extract(payload,'$.sampledAtMs')<=${input.nowMs} ORDER BY json_extract(payload,'$.sampledAtMs'),id`;
        const samples = yield* Effect.forEach(stored, (entry) => decodeSavedJson(entry.payload));
        const byId = new Map(samples.map((sample) => [sample.id, sample]));
        let current: SavedUsageEstimate | null = null;
        if (pricing) {
          const rows = yield* sql<{
            payload: string;
          }>`SELECT payload FROM usage_estimate_events WHERE source_id=${origin.id} AND timestamp_ms>=${cutoff} AND timestamp_ms<=${input.nowMs} ORDER BY timestamp_ms,id`;
          const events = yield* Effect.forEach(rows, (entry) => decodeEventJson(entry.payload));
          const intervals = selectUsageEstimateCycleSamples(events, source).slice(-2000);
          for (const interval of intervals) {
            const id = `automatic:${yield* encodeId([source.id, interval.key, interval.basis, 1])}`;
            if (byId.has(id)) continue;
            const sample: SavedUsageEstimate = {
              id,
              revision: row.revision,
              computedAtMs: yield* Clock.currentTimeMillis,
              sampledAtMs: interval.untilMs,
              quotaResetAtMs: interval.resetsAtMs,
              segmentStartMs: interval.segmentStartMs,
              result: withInputBlockers(
                (interval.basis === "cycle_to_date" ? estimateUsageCycle : estimateUsageInterval)(
                  source,
                  events.slice(
                    eventIndex(events, interval.fromMs, false),
                    eventIndex(events, interval.untilMs, true),
                  ),
                  pricing,
                  interval,
                ),
                origin.blockers,
              ),
            };
            yield* sql`INSERT INTO usage_estimate_results VALUES (${id},${source.id},${sample.computedAtMs},${yield* encodeSaved(sample)})`;
            byId.set(id, sample);
          }
          const latest = intervals.at(-1);
          if (latest)
            current = {
              id: yield* encodeId([
                source.id,
                row.revision,
                latest.key,
                pricing.id,
                latest.basis,
                1,
              ]),
              revision: row.revision,
              computedAtMs: yield* Clock.currentTimeMillis,
              result: withInputBlockers(
                (latest.basis === "cycle_to_date" ? estimateUsageCycle : estimateUsageInterval)(
                  source,
                  events.slice(
                    eventIndex(events, latest.fromMs, false),
                    eventIndex(events, latest.untilMs, true),
                  ),
                  pricing,
                  latest,
                ),
                origin.blockers,
              ),
              sampledAtMs: latest.untilMs,
              quotaResetAtMs: latest.resetsAtMs,
              segmentStartMs: latest.segmentStartMs,
            };
        }
        const cycleResets = [
          ...new Set(
            [...byId.values()]
              .filter((sample) => sample.result.basis === "cycle_to_date")
              .map((sample) => sample.quotaResetAtMs!),
          ),
        ];
        // Preserve old rows and their prices, but show one calculation basis per cycle.
        const history = [...byId.values()]
          .filter(
            (sample) =>
              sample.result.basis === "cycle_to_date" ||
              !cycleResets.some(
                (reset) =>
                  Math.abs(reset - sample.quotaResetAtMs!) <= USAGE_ESTIMATE_RESET_TOLERANCE_MS,
              ),
          )
          .toSorted((a, b) => a.sampledAtMs! - b.sampledAtMs!)
          .slice(-2000)
          .map((sample) => ({
            ...(sample.result.basis ? { basis: sample.result.basis } : {}),
            sampledAtMs: sample.sampledAtMs!,
            segmentStartMs: sample.segmentStartMs!,
            resetsAtMs: sample.quotaResetAtMs!,
            status: sample.result.status,
            fromMs: sample.result.interval?.fromMs ?? null,
            pricingId: sample.result.pricingId,
            consumedPercent: sample.result.interval?.consumedPercent ?? null,
            costUsd: sample.result.costUsd,
            cycleEquivalentUsd: sample.result.cycleEquivalentUsd,
            remainingEquivalentUsd: sample.result.remainingEquivalentUsd,
          }));
        series.push({
          source,
          sourcePath: origin.path,
          pricingAvailable: pricing !== null,
          current,
          history,
        });
      }
      return series;
    },
    sql.withTransaction,
    Effect.mapError((cause) => new UsageEstimateStoreError({ operation: "series", cause })),
  );
  return UsageEstimateStore.of({ databaseId, ingest, savePricing, evaluate, history, readSeries });
});

export const layer = Layer.effect(UsageEstimateStore, make);

export const DATABASE_FILE_NAME = "usage-estimates.sqlite";

/** Current source failures can clear after a refresh; they are not permanent log defects. */
function withInputBlockers(
  result: UsageIntervalEstimate,
  blockers: readonly string[] | undefined,
): UsageIntervalEstimate {
  return blockers?.length
    ? {
        ...result,
        status: "blocked",
        blockers: [...new Set([...result.blockers, ...blockers])],
        costUsd: null,
        cycleEquivalentUsd: null,
        remainingEquivalentUsd: null,
      }
    : result;
}

function eventIndex(events: readonly EstimateEvent[], timestamp: number, inclusive: boolean) {
  let start = 0;
  let end = events.length;
  while (start < end) {
    const mid = Math.floor((start + end) / 2);
    if (
      events[mid]!.timestampMs < timestamp ||
      (inclusive && events[mid]!.timestampMs === timestamp)
    )
      start = mid + 1;
    else end = mid;
  }
  return start;
}

/** Owns a private connection; never exposes it as the application's main SqlClient. */
export const layerLocal = (stateDir: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(stateDir, { recursive: true });
      const sqlite = NodeSqliteClient.layer({ filename: path.join(stateDir, DATABASE_FILE_NAME) });
      const initialize = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* UsageEstimateStore;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA busy_timeout = 5000`;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`PRAGMA synchronous = NORMAL`;
        }),
      ).pipe(Layer.provideMerge(layer), Layer.provide(sqlite));
      return initialize;
    }),
  );
