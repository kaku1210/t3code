import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as UsageEstimateReplay from "../src/usage/UsageEstimateReplay.ts";
import * as UsageEstimateStore from "../src/usage/UsageEstimateStore.ts";

const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const configuredT3Home = process.env.T3CODE_HOME;
class UsageReplayDestinationError extends Schema.TaggedError<UsageReplayDestinationError>()(
  "UsageReplayDestinationError",
  {},
) {
  override get message() {
    return "Replay requires an isolated database outside live T3 userdata.";
  }
}
const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    prices: { type: "string" },
    source: { type: "string" },
    device: { type: "string" },
    from: { type: "string" },
    until: { type: "string" },
  },
});
if (!values.db || !values.prices || !values.source || !values.device || positionals.length === 0) {
  throw new Error(
    "Usage: node apps/server/scripts/replay-usage-estimates.ts --db <isolated.sqlite> --prices <usage-model-rates.json> --source <origin-source-id> --device <origin-device-id> [--from <ISO>] [--until <ISO>] <transcript.jsonl>...",
  );
}
NodeRuntime.runMain(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const databasePath = path.resolve(values.db!);
    const liveRoots = [
      path.resolve(NodeOS.homedir(), ".t3", "userdata"),
      ...(configuredT3Home ? [path.resolve(configuredT3Home, "userdata")] : []),
    ];
    const isLive = (target: string, roots: readonly string[]) =>
      ["state.sqlite", "statev2.sqlite"].includes(path.basename(target).toLowerCase()) ||
      roots.some((root) => {
        const relative = path.relative(root, target);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
    if (isLive(databasePath, liveRoots)) return yield* new UsageReplayDestinationError();
    yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
    const resolvedRoots = yield* Effect.forEach(liveRoots, (root) =>
      Effect.gen(function* () {
        return (yield* fs.exists(root)) ? yield* fs.realPath(root) : root;
      }),
    );
    const resolvedTarget = (yield* fs.exists(databasePath))
      ? yield* fs.realPath(databasePath)
      : path.join(yield* fs.realPath(path.dirname(databasePath)), path.basename(databasePath));
    if (isLive(resolvedTarget, resolvedRoots)) return yield* new UsageReplayDestinationError();
    const local = UsageEstimateReplay.layer.pipe(
      Layer.provide(UsageEstimateStore.layer),
      Layer.provide(NodeSqliteClient.layer({ filename: databasePath })),
    );
    const result = yield* Effect.gen(function* () {
      const replay = yield* UsageEstimateReplay.UsageEstimateReplay;
      return yield* replay.replay({
        sourceId: values.source,
        deviceId: values.device,
        pricesPath: path.resolve(values.prices!),
        transcripts: positionals.map((file) => path.resolve(file)),
        fromMs: values.from ? Date.parse(values.from) : 0,
        untilMs: values.until ? Date.parse(values.until) : Number.MAX_SAFE_INTEGER,
      });
    }).pipe(Effect.provide(local));
    yield* Console.log(yield* encodeOutput({ databasePath, ...result }));
  }).pipe(Effect.provide(NodeServices.layer)),
);
