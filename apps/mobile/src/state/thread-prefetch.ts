import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";
import { environmentThreadShells } from "./threads";
import {
  persistedThreadSnapshotFromLoadResult,
  selectThreadPrefetchCandidates,
} from "./thread-prefetch-selection";

/** A thread is not fetched again within this window of its last write. */
const THREAD_PREFETCH_MIN_INTERVAL_MS = 5 * 60_000;
/** Parallel bounded-snapshot requests across all environments. */
const THREAD_PREFETCH_MAX_CONCURRENT = 4;
/** Foreground passes run at most this often. */
const THREAD_PREFETCH_FOREGROUND_MIN_INTERVAL_MS = 5 * 60_000;

interface ThreadPrefetchTarget {
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

const EMPTY_PREFETCH_TARGETS: ReadonlyArray<ThreadPrefetchTarget> = [];

/**
 * Per-environment prefetch candidates, emitted only when the candidate id set changes
 * and only while the environment has a prepared connection — the credential the bounded
 * HTTP path needs, available before the socket reaches "live". Shell snapshots arrive
 * from the persisted cache first, so cached threads prefetch immediately at launch.
 */
const threadPrefetchTargetsAtom = (() => {
  let previousSignature = "";
  let previousTargets: ReadonlyArray<ThreadPrefetchTarget> = EMPTY_PREFETCH_TARGETS;
  return Atom.make((get): ReadonlyArray<ThreadPrefetchTarget> => {
    const byEnvironment = new Map<EnvironmentId, EnvironmentThreadShell[]>();
    for (const shell of get(environmentThreadShells.navigationThreadShellsAtom)) {
      const list = byEnvironment.get(shell.environmentId);
      if (list === undefined) {
        byEnvironment.set(shell.environmentId, [shell]);
      } else {
        list.push(shell);
      }
    }
    const targets: ThreadPrefetchTarget[] = [];
    for (const [environmentId, threads] of byEnvironment) {
      if (Option.isNone(get(environmentSession.preparedConnectionValueAtom(environmentId)))) {
        continue;
      }
      const threadIds = selectThreadPrefetchCandidates(threads).map((thread) => thread.id);
      if (threadIds.length > 0) {
        targets.push({ environmentId, threadIds });
      }
    }
    targets.sort((left, right) => left.environmentId.localeCompare(right.environmentId));
    // Dispatch dedupes per thread anyway; this keeps the atom quiet while a run
    // streams shell updates that leave the candidate set untouched.
    const signature = targets
      .map((target) => `${target.environmentId}:${[...target.threadIds].sort().join(",")}`)
      .join(";");
    if (signature === previousSignature) {
      return previousTargets;
    }
    previousSignature = signature;
    previousTargets = targets;
    return targets;
  }).pipe(Atom.withLabel("mobile:thread-prefetch-targets"));
})();

type ThreadPrefetchOutcome = "saved" | "missing" | "skipped" | "unavailable";

const prefetchEnvironmentThreadSnapshot = createEnvironmentCommand(connectionAtomRuntime, {
  label: "mobile:thread-prefetch:snapshot",
  execute: Effect.fn("MobileThreadPrefetch.snapshot")(function* (
    threadId: ThreadId,
    _registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return "skipped" satisfies ThreadPrefetchOutcome;
    }
    const loader = yield* ThreadSnapshotLoader;
    const result = yield* loader.load(prepared.value, threadId);
    if (result._tag !== "present") {
      return result._tag satisfies ThreadPrefetchOutcome;
    }
    const cache = yield* Persistence.EnvironmentCacheStore;
    return yield* cache
      .saveThread(environmentId, persistedThreadSnapshotFromLoadResult(result))
      .pipe(
        Effect.as("saved" satisfies ThreadPrefetchOutcome),
        Effect.catchCause((cause) =>
          Effect.logDebug("Thread prefetch could not persist the snapshot.").pipe(
            Effect.annotateLogs({ environmentId, threadId, cause: String(cause) }),
            Effect.as("unavailable" satisfies ThreadPrefetchOutcome),
          ),
        ),
      );
  }),
});

/**
 * Warms the persisted thread-detail cache for each enabled environment's most relevant
 * threads so opening one resolves from cache instead of waiting on a cold snapshot
 * fetch. Runs for the app's lifetime; individual failures only skip that thread's next
 * freshness window.
 */
export function installThreadPrefetcher(): () => void {
  const lastPrefetchedAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const pending: Array<{ environmentId: EnvironmentId; threadId: ThreadId }> = [];
  const pendingKeys = new Set<string>();
  let disposed = false;
  let lastPassAt = 0;

  const freshnessKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
    `${environmentId}:${threadId}`;

  const isFresh = (key: string) => {
    const at = lastPrefetchedAt.get(key);
    return at !== undefined && Date.now() - at < THREAD_PREFETCH_MIN_INTERVAL_MS;
  };

  const pump = () => {
    while (inFlight.size < THREAD_PREFETCH_MAX_CONCURRENT) {
      if (disposed) {
        return;
      }
      const next = pending.shift();
      if (next === undefined) {
        return;
      }
      const key = freshnessKey(next.environmentId, next.threadId);
      pendingKeys.delete(key);
      if (inFlight.has(key) || isFresh(key)) {
        continue;
      }
      inFlight.add(key);
      void prefetchEnvironmentThreadSnapshot
        .run(appAtomRegistry, { environmentId: next.environmentId, input: next.threadId })
        .then((result) => {
          inFlight.delete(key);
          // Only a written or genuinely absent thread waits out the freshness window;
          // skipped/unavailable results retry on the next trigger.
          if (
            AsyncResult.isSuccess(result) &&
            (result.value === "saved" || result.value === "missing")
          ) {
            lastPrefetchedAt.set(key, Date.now());
          }
          pump();
        });
    }
  };

  const enqueue = (targets: ReadonlyArray<ThreadPrefetchTarget>) => {
    if (disposed) {
      return;
    }
    lastPassAt = Date.now();
    for (const target of targets) {
      for (const threadId of target.threadIds) {
        const key = freshnessKey(target.environmentId, threadId);
        if (inFlight.has(key) || pendingKeys.has(key) || isFresh(key)) {
          continue;
        }
        pendingKeys.add(key);
        pending.push({ environmentId: target.environmentId, threadId });
      }
    }
    pump();
  };

  const unsubscribeTargets = appAtomRegistry.subscribe(threadPrefetchTargetsAtom, enqueue, {
    immediate: true,
  });

  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (disposed || state !== "active") {
      return;
    }
    if (Date.now() - lastPassAt < THREAD_PREFETCH_FOREGROUND_MIN_INTERVAL_MS) {
      return;
    }
    enqueue(appAtomRegistry.get(threadPrefetchTargetsAtom));
  });

  return () => {
    disposed = true;
    unsubscribeTargets();
    appStateSubscription.remove();
  };
}
