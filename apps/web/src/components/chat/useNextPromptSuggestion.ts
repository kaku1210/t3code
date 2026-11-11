import { useAtomValue } from "@effect/atom-react";
import {
  type RunId,
  type ScopedThreadRef,
  WS_METHODS,
  isProviderAvailable,
  isProviderTextGenerationCapable,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent } from "react";
import {
  canRegenerateSuggestion,
  settlePromptSuggestion,
  type PromptSuggestionState,
  type PromptSuggestionUnavailableReason,
} from "@t3tools/client-runtime/state/prompt-suggestions";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useStableCallback } from "../../hooks/useStableCallback";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const generateSuggestion = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread:suggest-next-prompt",
  tag: WS_METHODS.threadPromptSuggestion,
});
type CachedSuggestion = { readonly runId: RunId; readonly state: PromptSuggestionState };

// Keep the latest attempt for each thread and model selection for this client session.
const useSuggestionCache = create<Readonly<Record<string, CachedSuggestion>>>(() => ({}));

/**
 * Fetches the host's shared result on entry; explicit regeneration replaces a successful suggestion.
 * The synchronous cache claim prevents repeat clicks and stale completions from winning a newer attempt.
 */
export function useNextPromptSuggestion(
  thread: ScopedThreadRef,
  runId: RunId | null,
  unavailableReason: PromptSuggestionUnavailableReason | null,
): { readonly state: PromptSuggestionState; readonly regenerate: (() => void) | null } {
  const { environmentId, threadId } = thread;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const selection = settings?.nextPromptSuggestionModelSelection ?? null;
  const key = JSON.stringify([environmentId, threadId, selection]);
  const cache = useSuggestionCache((entries) => entries[key]);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const provider = providers?.find((entry) => entry.instanceId === selection?.instanceId);
  const permitted = useAtomValue(generateSuggestion.permissionAtom(environmentId));
  const request = useStableCallback(useAtomCommand(generateSuggestion, { reportFailure: false }));
  const enabled =
    unavailableReason === null && permitted && settings?.nextPromptSuggestionsEnabled === true;
  const providerReady =
    provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider);

  const startSuggestion = (
    trigger: "auto" | "regenerate",
    cacheKey = key,
    completedRunId = runId,
  ) => {
    if (!enabled || !providerReady || completedRunId === null) return;
    const current = useSuggestionCache.getState()[cacheKey];
    if (trigger === "regenerate") {
      if (current?.runId !== completedRunId || !canRegenerateSuggestion(current.state)) return;
    } else if (current?.runId === completedRunId && current.state.status === "generating") {
      return;
    }

    // Claim the attempt synchronously so repeated clicks can't start a second request.
    const attempt: CachedSuggestion = { runId: completedRunId, state: { status: "generating" } };
    useSuggestionCache.setState({ [cacheKey]: attempt });
    void request({
      environmentId,
      input: {
        threadId,
        runId: completedRunId,
        ...(trigger === "regenerate" ? { regenerate: true } : {}),
      },
    }).then((result) => {
      if (useSuggestionCache.getState()[cacheKey] !== attempt) return;
      const state = settlePromptSuggestion(result);
      useSuggestionCache.setState({ [cacheKey]: { runId: completedRunId, state } });
    });
  };

  const requestOnEntry = useEffectEvent((entryKey: string, entryRunId: RunId) =>
    startSuggestion("auto", entryKey, entryRunId),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Re-entering an eligible turn reads its shared server result.
  useEffect(() => {
    if (enabled && providerReady && runId !== null) requestOnEntry(key, runId);
  }, [enabled, providerReady, key, runId]);

  if (settings?.nextPromptSuggestionsEnabled !== true) {
    return { state: { status: "unavailable", reason: "off" }, regenerate: null };
  }
  if (!permitted) {
    return { state: { status: "unavailable", reason: "permission" }, regenerate: null };
  }
  if (unavailableReason !== null || runId === null) {
    return {
      state: { status: "unavailable", reason: unavailableReason ?? "no-turn" },
      regenerate: null,
    };
  }
  if (selection === null) {
    return { state: { status: "empty", reason: "not-configured" }, regenerate: null };
  }
  if (providers === null) {
    return { state: { status: "unavailable", reason: "provider-loading" }, regenerate: null };
  }
  if (!providerReady) {
    return {
      state: {
        status: "empty",
        reason: provider?.enabled === false ? "provider-disabled" : "provider-unavailable",
      },
      regenerate: null,
    };
  }
  const state =
    cache?.runId === runId ? cache.state : ({ status: "unavailable", reason: "busy" } as const);
  return {
    state,
    regenerate: canRegenerateSuggestion(state) ? () => startSuggestion("regenerate") : null,
  };
}
