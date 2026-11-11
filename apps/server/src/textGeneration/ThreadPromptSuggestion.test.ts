import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { MessageId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as ThreadPromptSuggestion from "./ThreadPromptSuggestion.ts";

const threadId = ThreadId.make("suggestion-thread");
const runId = RunId.make("suggestion-run");
const userMessageId = MessageId.make("suggestion-user-message");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "suggestion-test-model",
};

function suggestionLayer(
  generatePromptSuggestion: TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"],
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"] = () =>
    Effect.succeed({
      projectId: ProjectId.make("suggestion-project"),
      latestRunId: runId,
      activeRunId: null,
      pendingRuntimeRequest: null,
    } as never),
) {
  return ThreadPromptSuggestion.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { projectId: ProjectId.make("suggestion-project") },
              runs: [{ id: runId, status: "completed", userMessageId }],
              messages: [
                { id: userMessageId, role: "user", text: "Fix the menu." },
                { role: "assistant", text: "The menu is fixed. The checks are still pending." },
                { role: "assistant", text: "Unfinished text", streaming: true },
              ],
            } as never),
        }),
        Layer.mock(TextGeneration.TextGeneration)({ generatePromptSuggestion }),
        ServerSettings.layerTest({
          nextPromptSuggestionsEnabled: true,
          nextPromptSuggestionModelSelection: modelSelection,
        }),
        NodeServices.layer,
      ),
    ),
  );
}

it.effect("uses the finished turn's text and the selected suggestion model", () => {
  const generatePromptSuggestion = vi.fn<
    TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"]
  >(() => Effect.succeed({ suggestion: " Run the checks.\n" }));
  const layer = suggestionLayer(generatePromptSuggestion);
  return Effect.gen(function* () {
    const service = yield* ThreadPromptSuggestion.ThreadPromptSuggestion;
    const stale = yield* service.generate({ threadId, runId: RunId.make("previous-run") });
    assert.deepEqual(stale, { suggestion: null, emptyReason: "turn-not-ready" });
    assert.equal(generatePromptSuggestion.mock.calls.length, 0);

    const result = yield* service.generate({ threadId, runId });
    assert.deepEqual(result, { suggestion: "Run the checks." });
    assert.equal(generatePromptSuggestion.mock.calls.length, 1);
    const request = generatePromptSuggestion.mock.calls[0]![0];
    assert.deepEqual(request.modelSelection, modelSelection);
    assert.include(request.prompt, "Fix the menu.");
    assert.include(request.prompt, "The checks are still pending.");
    assert.notInclude(request.prompt, "Unfinished text");

    assert.deepEqual(yield* service.generate({ threadId, runId }), result);
    assert.equal(generatePromptSuggestion.mock.calls.length, 1);

    generatePromptSuggestion.mockReturnValueOnce(Effect.succeed({ suggestion: null }));
    assert.deepEqual(yield* service.generate({ threadId, runId, regenerate: true }), {
      suggestion: null,
      emptyReason: "no-next-step",
    });

    const exhausted = { suggestion: null, emptyReason: "quota-exhausted" } as const;
    generatePromptSuggestion.mockReturnValueOnce(Effect.succeed(exhausted));
    assert.deepEqual(yield* service.generate({ threadId, runId, regenerate: true }), exhausted);

    generatePromptSuggestion.mockReturnValueOnce(Effect.succeed({ suggestion: "   " }));
    assert.deepEqual(yield* service.generate({ threadId, runId }), {
      suggestion: null,
      emptyReason: "invalid-suggestion",
    });

    const started = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    generatePromptSuggestion.mockReturnValueOnce(
      Effect.acquireUseRelease(
        Deferred.succeed(started, undefined),
        () => Effect.never,
        () => Deferred.succeed(released, undefined),
      ),
    );
    const pending = yield* service
      .generate({ threadId, runId })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("180 seconds");
    const timeout = yield* Fiber.join(pending);
    assert.equal(timeout._tag, "TextGenerationError");
    assert.include(timeout.detail, "timed out");
    yield* Deferred.await(released);

    generatePromptSuggestion.mockReturnValueOnce(
      Effect.succeed({ suggestion: "Retry the checks." }),
    );
    assert.deepEqual(yield* service.generate({ threadId, runId }), {
      suggestion: "Retry the checks.",
    });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "shares pending work across clients, survives one disconnection, and refreshes completed results",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<{ suggestion: string }>();
      const released = yield* Deferred.make<void>();
      const generate = vi.fn<TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"]>(
        () =>
          Effect.acquireUseRelease(
            Deferred.succeed(started, undefined),
            () => Deferred.await(reply),
            () => Deferred.succeed(released, undefined),
          ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPromptSuggestion.ThreadPromptSuggestion;
        const first = yield* service.generate({ threadId, runId }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* service
          .generate({ threadId, runId, regenerate: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        assert.isFalse(yield* Deferred.isDone(released));
        yield* Deferred.succeed(reply, { suggestion: "Review the menu." });
        assert.deepEqual(yield* Fiber.join(second), { suggestion: "Review the menu." });
        assert.deepEqual(yield* service.generate({ threadId, runId }), {
          suggestion: "Review the menu.",
        });
        assert.equal(generate.mock.calls.length, 1);
        generate.mockReturnValueOnce(Effect.succeed({ suggestion: "Run the tests." }));
        assert.deepEqual(yield* service.generate({ threadId, runId, regenerate: true }), {
          suggestion: "Run the tests.",
        });
        assert.equal(generate.mock.calls.length, 2);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          nextPromptSuggestionModelSelection: { ...modelSelection, model: "another-model" },
        });
        generate.mockReturnValueOnce(Effect.succeed({ suggestion: "Review the result." }));
        assert.deepEqual(yield* service.generate({ threadId, runId }), {
          suggestion: "Review the result.",
        });
        assert.equal(generate.mock.calls.length, 3);
        yield* settings.updateSettings({ nextPromptSuggestionsEnabled: false });
        assert.deepEqual(yield* service.generate({ threadId, runId }), {
          suggestion: null,
          emptyReason: "not-configured",
        });
        assert.equal(generate.mock.calls.length, 3);
      }).pipe(Effect.provide(suggestionLayer(generate)));
    }),
);

it.effect.each(["stale", "timeout"] as const)(
  "drops %s queued work without another model request",
  (outcome) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<{ suggestion: string }>();
      const otherThread = ThreadId.make("other-thread");
      let stale = false;
      const generate = vi.fn<TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"]>(
        () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      );
      const layer = suggestionLayer(generate, (id) =>
        Effect.succeed({
          projectId: ProjectId.make("suggestion-project"),
          latestRunId: id === otherThread && stale ? RunId.make("newer-run") : runId,
          activeRunId: null,
          pendingRuntimeRequest: null,
        } as never),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPromptSuggestion.ThreadPromptSuggestion;
        const active = yield* service.generate({ threadId, runId }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const queued = yield* service
          .generate({ threadId: otherThread, runId })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        if (outcome === "timeout") {
          yield* TestClock.adjust("60 seconds");
          const failure = yield* Fiber.join(queued);
          assert.equal(failure._tag, "Failure");
          if (failure._tag === "Failure") assert.include(failure.failure.detail, "queue is busy");
        } else {
          stale = true;
        }
        yield* Deferred.succeed(reply, { suggestion: "Run checks." });
        yield* Fiber.join(active);
        if (outcome === "stale") {
          const result = yield* Fiber.join(queued);
          assert.equal(result._tag, "Success");
          if (result._tag === "Success")
            assert.deepEqual(result.success, { suggestion: null, emptyReason: "turn-not-ready" });
        }
        assert.equal(generate.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
);
