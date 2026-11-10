import { useAtomValue } from "@effect/atom-react";
import {
  type RunId,
  type ScopedThreadRef,
  type ThreadPromptSuggestionResult,
  WS_METHODS,
  isProviderAvailable,
  isProviderTextGenerationCapable,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useEffect } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useStableCallback } from "../../hooks/useStableCallback";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const generateSuggestion = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread:suggest-next-prompt",
  tag: WS_METHODS.threadPromptSuggestion,
});

type SuggestionOutcome = ThreadPromptSuggestionResult | "failed" | "retrying";
type CachedSuggestion = { readonly runId: RunId; readonly outcome: SuggestionOutcome | null };

// Keep the latest attempt for each thread and model selection for this client session.
const useSuggestionCache = create<Readonly<Record<string, CachedSuggestion>>>(() => ({}));

function canRetrySuggestion(outcome: SuggestionOutcome | null): boolean {
  return (
    outcome === "failed" ||
    (typeof outcome === "object" &&
      outcome?.suggestion === null &&
      outcome.emptyReason === "invalid-suggestion")
  );
}

/**
 * Requests a suggestion for the open, eligible turn and exposes a retry for failed attempts.
 * A null outcome keeps the normal composer hint while no result is available.
 */
export function useNextPromptSuggestion(
  thread: ScopedThreadRef,
  runId: RunId | null,
  eligible: boolean,
): { readonly outcome: SuggestionOutcome | null; readonly retry: (() => void) | null } {
  const { environmentId, threadId } = thread;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const selection = settings?.nextPromptSuggestionModelSelection ?? null;
  const key = JSON.stringify([environmentId, threadId, selection]);
  const cache = useSuggestionCache((entries) => entries[key]);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const provider = providers?.find((entry) => entry.instanceId === selection?.instanceId);
  const permitted = useAtomValue(generateSuggestion.permissionAtom(environmentId));
  const request = useStableCallback(useAtomCommand(generateSuggestion));
  const enabled = eligible && permitted && settings?.nextPromptSuggestionsEnabled === true;
  const providerReady =
    provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider);

  const startSuggestion = (trigger: "auto" | "retry") => {
    if (!enabled || !providerReady || runId === null) return;
    const current = useSuggestionCache.getState()[key];
    if (trigger === "retry") {
      if (current?.runId !== runId || !canRetrySuggestion(current.outcome)) return;
    } else if (current?.runId === runId) {
      return;
    }

    // Claim the attempt synchronously so repeated clicks can't start a second request.
    const attempt: CachedSuggestion = { runId, outcome: trigger === "retry" ? "retrying" : null };
    useSuggestionCache.setState({ [key]: attempt });
    void request({ environmentId, input: { threadId, runId } }).then((result) => {
      if (useSuggestionCache.getState()[key] !== attempt) return;
      useSuggestionCache.setState({
        [key]: { runId, outcome: result._tag === "Success" ? result.value : "failed" },
      });
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opening an eligible thread requests a suggestion once from its environment.
  useEffect(() => {
    startSuggestion("auto");
  }, [startSuggestion]);

  if (!enabled || runId === null) return { outcome: null, retry: null };
  if (selection === null) {
    return { outcome: { suggestion: null, emptyReason: "not-configured" }, retry: null };
  }
  if (providers === null) return { outcome: null, retry: null };
  if (!providerReady) {
    return { outcome: { suggestion: null, emptyReason: "provider-unavailable" }, retry: null };
  }
  const outcome = cache?.runId === runId ? cache.outcome : null;
  return { outcome, retry: canRetrySuggestion(outcome) ? () => startSuggestion("retry") : null };
}
