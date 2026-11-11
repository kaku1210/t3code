import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  canRegenerateSuggestion,
  settlePromptSuggestion,
  type PromptSuggestionState,
} from "@t3tools/client-runtime/state/prompt-suggestions";
import {
  type ScopedThreadRef,
  type RunId,
  WS_METHODS,
  isProviderAvailable,
  isProviderTextGenerationCapable,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const generateSuggestion = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread:suggest-next-prompt",
  tag: WS_METHODS.threadPromptSuggestion,
});

type CachedSuggestion = { readonly runId: RunId; readonly state: PromptSuggestionState };
// Presentation cache only; completed results and in-flight requests are shared by the server.
const suggestionsAtom = Atom.make<Readonly<Record<string, CachedSuggestion>>>({}).pipe(
  Atom.keepAlive,
);

/** Reads the host's suggestion on entry; retries and late responses follow the same rules as desktop. */
export function useNextPromptSuggestion(
  thread: ScopedThreadRef,
  runId: RunId | null,
  eligible: boolean,
): { readonly state: PromptSuggestionState; readonly regenerate: (() => void) | null } {
  const { environmentId, threadId } = thread;
  const registry = useContext(RegistryContext);
  const entries = useAtomValue(suggestionsAtom);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const permitted = useAtomValue(generateSuggestion.permissionAtom(environmentId));
  const request = useAtomCommand(generateSuggestion, { reportFailure: false });
  const selection = settings?.nextPromptSuggestionModelSelection ?? null;
  const provider = providers?.find((p) => p.instanceId === selection?.instanceId);
  const enabled = eligible && permitted && settings?.nextPromptSuggestionsEnabled === true;
  const providerReady =
    provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider);
  const key = JSON.stringify([environmentId, threadId, selection]);

  const startSuggestion = (
    trigger: "auto" | "regenerate",
    cacheKey = key,
    completedRunId = runId,
  ) => {
    if (!enabled || !providerReady || completedRunId === null) return;
    const current = registry.get(suggestionsAtom)[cacheKey];
    if (trigger === "regenerate") {
      if (current?.runId !== completedRunId || !canRegenerateSuggestion(current.state)) return;
    } else if (current?.runId === completedRunId && current.state.status === "generating") {
      return;
    }
    const attempt: CachedSuggestion = { runId: completedRunId, state: { status: "generating" } };
    registry.set(suggestionsAtom, { ...registry.get(suggestionsAtom), [cacheKey]: attempt });
    void request({
      environmentId,
      input: {
        threadId,
        runId: completedRunId,
        ...(trigger === "regenerate" ? { regenerate: true } : {}),
      },
    }).then((result) => {
      const current = registry.get(suggestionsAtom);
      if (current[cacheKey] !== attempt) return;
      registry.set(suggestionsAtom, {
        ...current,
        [cacheKey]: { runId: completedRunId, state: settlePromptSuggestion(result) },
      });
    });
  };

  const requestOnEntry = useEffectEvent((entryKey: string, entryRunId: RunId) =>
    startSuggestion("auto", entryKey, entryRunId),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Re-entering an eligible turn reads the shared host result.
  useEffect(() => {
    if (enabled && providerReady && runId !== null) requestOnEntry(key, runId);
  }, [enabled, providerReady, key, runId]);

  if (!settings?.nextPromptSuggestionsEnabled)
    return { state: { status: "unavailable", reason: "off" }, regenerate: null };
  if (!permitted)
    return { state: { status: "unavailable", reason: "permission" }, regenerate: null };
  if (!eligible || runId === null)
    return {
      state: { status: "unavailable", reason: runId === null ? "no-turn" : "busy" },
      regenerate: null,
    };
  if (selection === null)
    return { state: { status: "empty", reason: "not-configured" }, regenerate: null };
  if (providers === null)
    return { state: { status: "unavailable", reason: "provider-loading" }, regenerate: null };
  if (!providerReady) {
    return {
      state: {
        status: "empty",
        reason: provider?.enabled === false ? "provider-disabled" : "provider-unavailable",
      },
      regenerate: null,
    };
  }
  const cache = entries[key];
  const state =
    cache?.runId === runId ? cache.state : ({ status: "unavailable", reason: "busy" } as const);
  return {
    state,
    regenerate: canRegenerateSuggestion(state) ? () => startSuggestion("regenerate") : null,
  };
}
