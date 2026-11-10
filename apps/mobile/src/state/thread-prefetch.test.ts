import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ThreadId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";
import {
  persistedThreadSnapshotFromLoadResult,
  selectThreadPrefetchCandidates,
  THREAD_PREFETCH_LIMIT_PER_ENVIRONMENT,
} from "./thread-prefetch-selection";

const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    id: ThreadId.make(id),
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("selectThreadPrefetchCandidates", () => {
  it("keeps listed, unsettled, unsnoozed threads and drops the rest", () => {
    const candidates = selectThreadPrefetchCandidates(
      [
        makeThread("plain", { createdAt: "2026-03-01T00:00:00.000Z" }),
        makeThread("archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
        makeThread("deleted", { deletedAt: "2026-01-02T00:00:00.000Z" }),
        makeThread("settled", { settledOverride: "settled" }),
        makeThread("manually-active", {
          settledOverride: "active",
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
        makeThread("snoozed", { snoozedUntil: "2026-06-03T00:00:00.000Z" }),
        makeThread("woke", {
          snoozedUntil: "2026-06-01T00:00:00.000Z",
          createdAt: "2026-01-15T00:00:00.000Z",
        }),
        makeThread("subagent", {
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
        makeThread("side-chat", {
          lineage: {
            rootThreadId: ThreadId.make("side-chat"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: null,
            sideChat: true,
          },
        }),
      ],
      { now: NOW },
    );

    expect(candidates.map((thread) => thread.id)).toEqual([
      ThreadId.make("plain"),
      ThreadId.make("manually-active"),
      ThreadId.make("woke"),
    ]);
  });

  it("orders pinned threads before active ones and sorts each section like the list", () => {
    const candidates = selectThreadPrefetchCandidates(
      [
        makeThread("active-old", { createdAt: "2026-01-01T00:00:00.000Z" }),
        makeThread("pinned-b", {
          pinnedAt: "2026-01-03T00:00:00.000Z",
          pinOrderKey: "b",
        }),
        makeThread("active-new", { createdAt: "2026-02-01T00:00:00.000Z" }),
        makeThread("pinned-a", {
          pinnedAt: "2026-01-02T00:00:00.000Z",
          pinOrderKey: "a",
        }),
      ],
      { now: NOW },
    );

    expect(candidates.map((thread) => thread.id)).toEqual([
      ThreadId.make("pinned-a"),
      ThreadId.make("pinned-b"),
      ThreadId.make("active-new"),
      ThreadId.make("active-old"),
    ]);
  });

  it("caps the selection at the per-environment limit", () => {
    const threads = Array.from({ length: THREAD_PREFETCH_LIMIT_PER_ENVIRONMENT + 3 }, (_, index) =>
      makeThread(`thread-${index}`, {
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      }),
    );

    const candidates = selectThreadPrefetchCandidates(threads, { now: NOW });

    expect(candidates).toHaveLength(THREAD_PREFETCH_LIMIT_PER_ENVIRONMENT);
    // Newest first among keyless active threads.
    expect(candidates[0]?.id).toBe(
      ThreadId.make(`thread-${THREAD_PREFETCH_LIMIT_PER_ENVIRONMENT + 2}`),
    );
  });
});

describe("persistedThreadSnapshotFromLoadResult", () => {
  const projection = {
    threadId: ThreadId.make("thread-1"),
  } as unknown as OrchestrationV2ThreadProjection;

  it("persists sequence, projection and history metadata for a bounded load", () => {
    const snapshot = persistedThreadSnapshotFromLoadResult({
      _tag: "present",
      snapshot: {
        snapshotSequence: 41,
        projection,
        latestLocalTurnOrdinal: 7,
      },
      history: {
        historyCursor: "cursor-1",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 7,
      },
    });

    expect(snapshot).toEqual({
      snapshotSequence: 41,
      projection,
      historyCursor: "cursor-1",
      hasMoreHistory: true,
      latestLocalTurnOrdinal: 7,
    } satisfies OrchestrationV2ThreadDetailSnapshot);
  });

  it("defaults missing history metadata the way a complete snapshot persists", () => {
    const snapshot = persistedThreadSnapshotFromLoadResult({
      _tag: "present",
      snapshot: { snapshotSequence: 9, projection },
    });

    expect(snapshot.historyCursor).toBeNull();
    expect(snapshot.hasMoreHistory).toBe(false);
    expect(snapshot.latestLocalTurnOrdinal).toBeNull();
  });
});
