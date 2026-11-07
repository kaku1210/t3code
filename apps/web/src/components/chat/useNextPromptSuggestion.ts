import { useAtomValue } from "@effect/atom-react";
import {
  type RunId,
  type ScopedThreadRef,
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

type CachedSuggestion = { readonly runId: RunId; readonly suggestion: string | null };

// The latest attempted turn per thread survives navigation for this client session.
const useSuggestionCache = create<Readonly<Record<string, CachedSuggestion>>>(() => ({}));

/** Reads or requests a suggestion for the open thread when its composer is eligible. */
export function useNextPromptSuggestion(
  thread: ScopedThreadRef,
  runId: RunId | null,
  eligible: boolean,
): string | null {
  const { environmentId, threadId } = thread;
  const key = JSON.stringify([environmentId, threadId]);
  const cache = useSuggestionCache((entries) => entries[key]);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const provider = providers?.find(
    (entry) => entry.instanceId === settings?.nextPromptSuggestionModelSelection?.instanceId,
  );
  const permitted = useAtomValue(generateSuggestion.permissionAtom(environmentId));
  const request = useStableCallback(useAtomCommand(generateSuggestion));
  const enabled =
    eligible &&
    permitted &&
    settings?.nextPromptSuggestionsEnabled === true &&
    provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opening an eligible thread requests a suggestion once from its environment.
  useEffect(() => {
    if (!enabled || runId === null || useSuggestionCache.getState()[key]?.runId === runId) return;
    useSuggestionCache.setState({ [key]: { runId, suggestion: null } });
    void request({ environmentId, input: { threadId, runId } }).then((result) => {
      if (useSuggestionCache.getState()[key]?.runId !== runId || result._tag !== "Success") return;
      useSuggestionCache.setState({ [key]: { runId, suggestion: result.value.suggestion } });
    });
  }, [enabled, environmentId, key, request, runId, threadId]);

  return enabled && cache?.runId === runId ? cache.suggestion : null;
}
