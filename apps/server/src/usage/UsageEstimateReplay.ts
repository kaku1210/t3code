import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SavedUsageEstimate } from "@t3tools/contracts";

import { parseCodexEstimateTranscript } from "./codexEstimateTranscript.ts";
import * as UsageEstimateStore from "./UsageEstimateStore.ts";
import { parseRateTable } from "./usagePricing.ts";

export class UsageEstimateReplayError extends Schema.TaggedError<UsageEstimateReplayError>()(
  "UsageEstimateReplayError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not replay local Codex usage into the estimate store.";
  }
}
const isReplayError = Schema.is(UsageEstimateReplayError);

const ReplayInput = Schema.Struct({
  sourceId: Schema.String.check(Schema.isMinLength(1)),
  deviceId: Schema.String.check(Schema.isMinLength(1)),
  transcripts: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  pricesPath: Schema.String,
  fromMs: Schema.Finite,
  untilMs: Schema.Finite,
});
const PriceCache = Schema.Struct({ fetchedAtMs: Schema.Finite, document: Schema.Unknown });
const decodeInput = Schema.decodeUnknownEffect(ReplayInput);
const decodePriceCache = Schema.decodeUnknownEffect(Schema.fromJsonString(PriceCache));

export class UsageEstimateReplay extends Context.Service<
  UsageEstimateReplay,
  {
    readonly replay: (input: unknown) => Effect.Effect<
      {
        readonly inserted: number;
        readonly missingQuotaTicks: number;
        readonly filesWithPendingTail: number;
        readonly saved: SavedUsageEstimate;
      },
      UsageEstimateReplayError
    >;
  }
>()("t3/usage/UsageEstimateReplay") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* UsageEstimateStore.UsageEstimateStore;
  const replay = Effect.fn("UsageEstimateReplay.replay")(
    function* (raw: unknown) {
      const input = yield* decodeInput(raw);
      const cache = yield* fs
        .readFileString(input.pricesPath)
        .pipe(Effect.flatMap(decodePriceCache));
      const pricingId = `model-rates:${cache.fetchedAtMs}`;
      yield* store.savePricing({
        id: pricingId,
        description: "Local cached model rates; no live price fetch or custom overrides",
        rates: Object.fromEntries(parseRateTable(cache.document)),
      });
      const parsed = yield* Effect.forEach(input.transcripts, (path) =>
        fs.readFileString(path).pipe(
          Effect.flatMap((contents) =>
            Effect.try({
              try: () => parseCodexEstimateTranscript(contents),
              catch: (cause) => new UsageEstimateReplayError({ cause }),
            }),
          ),
        ),
      );
      // Historical log files have no verified account binding. Never infer it from today's login.
      const ingested = yield* store.ingest({
        source: {
          id: input.sourceId,
          deviceId: input.deviceId,
          accountId: null,
          coverage: "selected_sessions",
        },
        events: parsed.flatMap((file) => file.events),
      });
      const saved = yield* store.evaluate({
        sourceId: input.sourceId,
        pricingId,
        fromMs: input.fromMs,
        untilMs: input.untilMs,
      });
      return {
        inserted: ingested.inserted,
        missingQuotaTicks: parsed.reduce((sum, file) => sum + file.missingQuotaTicks, 0),
        filesWithPendingTail: parsed.filter((file) => file.pendingTail).length,
        saved,
      };
    },
    Effect.mapError((cause) =>
      isReplayError(cause) ? cause : new UsageEstimateReplayError({ cause }),
    ),
  );
  return UsageEstimateReplay.of({ replay });
});

export const layer = Layer.effect(UsageEstimateReplay, make);
