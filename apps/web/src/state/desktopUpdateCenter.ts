import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateCenterState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";

export function getUpdateCenterBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.updateCenter;
}
class UpdateCenterReadError extends Schema.TaggedError<UpdateCenterReadError>()(
  "UpdateCenterReadError",
  { cause: Schema.Defect() },
) {}
const stateAtom = Atom.make(
  Stream.callback<DesktopUpdateCenterState | null>((queue) =>
    Effect.gen(function* () {
      const bridge = getUpdateCenterBridge();
      if (!bridge) {
        Queue.offerUnsafe(queue, null);
        return yield* Effect.never;
      }
      let received = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onState((state) => {
            received = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const state = yield* Effect.tryPromise({
        try: () => bridge.getState(),
        catch: (cause) => new UpdateCenterReadError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("Cannot read desktop update center", error).pipe(Effect.as(null)),
        ),
      );
      if (!received) Queue.offerUnsafe(queue, state);
      return yield* Effect.never;
    }),
  ),
  { initialValue: null },
).pipe(Atom.keepAlive);

export function useDesktopUpdateCenter(): DesktopUpdateCenterState | null {
  return AsyncResult.getOrElse(useAtomValue(stateAtom), () => null);
}
