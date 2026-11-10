import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { ThreadSnapshotLoadResult } from "@t3tools/client-runtime/state/threads";
import {
  isListedThreadLineage,
  type OrchestrationV2ThreadDetailSnapshot,
} from "@t3tools/contracts";

/** Threads each environment warms per pass, in list order. */
export const THREAD_PREFETCH_LIMIT_PER_ENVIRONMENT = 10;

/**
 * Threads worth warming in thread-list order (pinned first, then active), excluding
 * archived, deleted, settled, effectively snoozed and non-listed threads like
 * getThreadListV2OrderedSection does.
 */
export function selectThreadPrefetchCandidates(
  threads: readonly EnvironmentThreadShell[],
  options: { readonly now?: string; readonly limit?: number } = {},
): EnvironmentThreadShell[] {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? THREAD_PREFETCH_LIMIT_PER_ENVIRONMENT;
  const eligible = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.settledOverride !== "settled" &&
      isListedThreadLineage(thread.lineage) &&
      !effectiveSnoozed(thread, { now }),
  );
  const pinned = sortPinnedThreadsByOrderKey(eligible.filter((thread) => thread.pinnedAt != null));
  const active = sortActiveThreadsByOrderKey(eligible.filter((thread) => thread.pinnedAt == null));
  return [...pinned, ...active].slice(0, limit);
}

/**
 * The cache record a fresh thread open persists for a bounded load once the server
 * accepts bounded snapshots (always true on mobile). Mirrors the bounded branch of
 * snapshotToPersist in client-runtime state/threads.ts: sequence, projection and the
 * history metadata that lets the socket resume with afterSequence = snapshotSequence.
 */
export function persistedThreadSnapshotFromLoadResult(
  result: Extract<ThreadSnapshotLoadResult, { readonly _tag: "present" }>,
): OrchestrationV2ThreadDetailSnapshot {
  return {
    snapshotSequence: result.snapshot.snapshotSequence,
    projection: result.snapshot.projection,
    historyCursor: result.history?.historyCursor ?? null,
    hasMoreHistory: result.history?.hasMoreHistory ?? false,
    latestLocalTurnOrdinal: result.history?.latestLocalTurnOrdinal ?? null,
  };
}
