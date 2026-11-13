// Asks a T3 Code Plus client using this checkout for Quick local update to compare it again now.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { LOCAL_UPDATE_REFRESH_FILE } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const notifyLocalUpdate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = path.join(import.meta.dirname, "..", "release");
  yield* fs.makeDirectory(release, { recursive: true });
  yield* fs.writeFileString(
    path.join(release, LOCAL_UPDATE_REFRESH_FILE),
    `${DateTime.formatIso(yield* DateTime.now)}\n`,
  );
});

notifyLocalUpdate.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
