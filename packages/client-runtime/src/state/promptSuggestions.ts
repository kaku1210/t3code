import {
  EnvironmentAuthorizationError,
  TextGenerationError,
  type ThreadPromptSuggestionResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import type { AtomCommandResult } from "./runtime.ts";

export type PromptSuggestionUnavailableReason =
  | "running"
  | "draft"
  | "approval"
  | "busy"
  | "no-turn"
  | "off"
  | "permission"
  | "provider-loading";

/** Shared suggestion states and retry rules for desktop, web, and mobile. */
export type PromptSuggestionState =
  | { readonly status: "unavailable"; readonly reason: PromptSuggestionUnavailableReason }
  | { readonly status: "generating" }
  | { readonly status: "ready"; readonly suggestion: string }
  | { readonly status: "empty"; readonly reason: ThreadPromptSuggestionResult["emptyReason"] }
  | { readonly status: "failed"; readonly detail: string | null; readonly retryable: boolean };

const isTextGenerationError = Schema.is(TextGenerationError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export function canRegenerateSuggestion(state: PromptSuggestionState): boolean {
  return (
    state.status === "ready" ||
    (state.status === "failed" && state.retryable) ||
    (state.status === "empty" && state.reason === "invalid-suggestion")
  );
}

export function settlePromptSuggestion(
  result: AtomCommandResult<ThreadPromptSuggestionResult, unknown>,
): PromptSuggestionState {
  if (result._tag === "Success") {
    return result.value.suggestion === null
      ? { status: "empty", reason: result.value.emptyReason }
      : { status: "ready", suggestion: result.value.suggestion };
  }
  const failure = Cause.squash(result.cause);
  return {
    status: "failed",
    detail: isTextGenerationError(failure)
      ? failure.detail
      : failure instanceof Error
        ? failure.message
        : null,
    retryable: !isAuthorizationError(failure),
  };
}
