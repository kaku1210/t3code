import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

// Windows taskkill closes provider children before the backend can receive a shutdown signal.
export const desktopShutdownMarkerPath = (baseDir: string, pid: number) =>
  `${baseDir}/runtime/desktop-shutdown-${pid}`;

/** Publish before terminating the owned backend tree; remove after its scope has closed. */
export const markDesktopBackendShutdown = Effect.fn("markDesktopBackendShutdown")(function* (
  baseDir: string,
  pid: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const marker = desktopShutdownMarkerPath(baseDir, pid);
  yield* fs.makeDirectory(`${baseDir}/runtime`, { recursive: true });
  yield* fs.writeFileString(marker, String(yield* Clock.currentTimeMillis));
  return marker;
});

const decodeTimestamp = Schema.decodeUnknownEffect(Schema.NumberFromString);

/** A marker for an earlier process or an old stop attempt must not suppress a real failure. */
export const isDesktopBackendShuttingDown = Effect.fn("isDesktopBackendShuttingDown")(function* (
  baseDir: string,
  pid: number,
  startedAt: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const requestedAt = yield* fs.readFileString(desktopShutdownMarkerPath(baseDir, pid)).pipe(
    Effect.flatMap(decodeTimestamp),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.logWarning("Could not read the desktop shutdown marker", { cause: error }).pipe(
            Effect.as(null),
          ),
    ),
  );
  if (requestedAt === null) return false;
  const now = yield* Clock.currentTimeMillis;
  return requestedAt >= startedAt && requestedAt <= now && now - requestedAt < 30_000;
});
