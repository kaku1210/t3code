import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
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

type CachedSuggestion = { readonly runId: RunId; readonly suggestion: string | null };
// Client-session cache: revisiting a completed turn must not spend another model request.
const suggestionsAtom = Atom.make<Readonly<Record<string, CachedSuggestion>>>({}).pipe(
  Atom.keepAlive,
);

/** Requests the latest completed run once per environment-scoped thread while cached; late replies never overwrite a newer run. */
export function useNextPromptSuggestion(
  thread: ScopedThreadRef,
  runId: RunId | null,
  eligible: boolean,
) {
  const registry = useContext(RegistryContext);
  const entries = useAtomValue(suggestionsAtom);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(thread.environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(thread.environmentId));
  const permitted = useAtomValue(generateSuggestion.permissionAtom(thread.environmentId));
  const request = useEffectEvent(useAtomCommand(generateSuggestion));
  const provider = providers?.find(
    (p) => p.instanceId === settings?.nextPromptSuggestionModelSelection?.instanceId,
  );
  const enabled =
    eligible &&
    permitted &&
    settings?.nextPromptSuggestionsEnabled === true &&
    provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider);
  const { environmentId, threadId } = thread;
  const key = JSON.stringify([environmentId, threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- An eligible completed run requests a server suggestion once, outside render.
  useEffect(() => {
    if (!enabled || runId === null || registry.get(suggestionsAtom)[key]?.runId === runId) return;
    registry.set(suggestionsAtom, {
      ...registry.get(suggestionsAtom),
      [key]: { runId, suggestion: null },
    });
    void request({ environmentId, input: { threadId, runId } }).then((result) => {
      const current = registry.get(suggestionsAtom);
      if (result._tag !== "Success" || current[key]?.runId !== runId) return;
      registry.set(suggestionsAtom, {
        ...current,
        [key]: { runId, suggestion: result.value.suggestion },
      });
    });
  }, [enabled, environmentId, key, registry, runId, threadId]);

  return enabled && entries[key]?.runId === runId ? entries[key].suggestion : null;
}
