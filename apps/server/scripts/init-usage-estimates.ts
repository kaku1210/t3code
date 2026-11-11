import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeUtil from "node:util";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../src/config.ts";
import * as UsageEstimateStore from "../src/usage/UsageEstimateStore.ts";

const { values } = NodeUtil.parseArgs({ options: { home: { type: "string" } } });
if (!values.home)
  throw new Error("Usage: node apps/server/scripts/init-usage-estimates.ts --home <T3-home>");
const encodeOutput = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      databasePath: Schema.String,
      databaseId: Schema.String,
    }),
  ),
);

// Explicit initialization opens only the estimate database, without starting the server.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.deriveServerPaths(
      path.resolve(values.home!),
      undefined,
      {
        baseDirIsExplicit: true,
      },
    );
    const databaseId = yield* Effect.gen(function* () {
      return (yield* UsageEstimateStore.UsageEstimateStore).databaseId;
    }).pipe(Effect.provide(UsageEstimateStore.layerLocal(stateDir)));
    yield* Console.log(
      yield* encodeOutput({
        databasePath: path.join(stateDir, UsageEstimateStore.DATABASE_FILE_NAME),
        databaseId,
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
