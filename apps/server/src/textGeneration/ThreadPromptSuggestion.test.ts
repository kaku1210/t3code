import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { MessageId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

it.effect("uses the finished turn's text and the selected suggestion model", () => {
  const generatePromptSuggestion = vi.fn<
    TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"]
  >(() => Effect.succeed({ suggestion: " Run the checks.\n" }));
  const layer = ThreadPromptSuggestion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              latestRunId: runId,
              activeRunId: null,
              pendingRuntimeRequest: null,
            } as never),
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

    generatePromptSuggestion.mockReturnValueOnce(Effect.succeed({ suggestion: null }));
    assert.deepEqual(yield* service.generate({ threadId, runId }), {
      suggestion: null,
      emptyReason: "no-next-step",
    });

    const exhausted = { suggestion: null, emptyReason: "quota-exhausted" } as const;
    generatePromptSuggestion.mockReturnValueOnce(Effect.succeed(exhausted));
    assert.deepEqual(yield* service.generate({ threadId, runId }), exhausted);

    generatePromptSuggestion.mockReturnValueOnce(Effect.succeed({ suggestion: "   " }));
    assert.deepEqual(yield* service.generate({ threadId, runId }), {
      suggestion: null,
      emptyReason: "invalid-suggestion",
    });
  }).pipe(Effect.provide(layer));
});
