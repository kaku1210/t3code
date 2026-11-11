import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import { isDesktopBackendShuttingDown, markDesktopBackendShutdown } from "./desktopShutdown.ts";

it.layer(NodeServices.layer)("desktop shutdown intent", (it) => {
  it.effect("matches only a current stop for the exact backend process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      assert.isFalse(yield* isDesktopBackendShuttingDown(directory, 123, 0));
      const marker = yield* markDesktopBackendShutdown(directory, 123);
      assert.isTrue(yield* isDesktopBackendShuttingDown(directory, 123, 0));
      assert.isFalse(yield* isDesktopBackendShuttingDown(directory, 456, 0));
      assert.isFalse(yield* isDesktopBackendShuttingDown(directory, 123, 1));
      yield* TestClock.adjust("30 seconds");
      assert.isFalse(yield* isDesktopBackendShuttingDown(directory, 123, 0));
      yield* fs.writeFileString(marker, "invalid");
      assert.isFalse(yield* isDesktopBackendShuttingDown(directory, 123, 0));
    }),
  );
});
