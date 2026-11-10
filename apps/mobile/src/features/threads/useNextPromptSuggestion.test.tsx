import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  RunId,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  state: {} as {
    settings: Atom.Writable<ServerSettings, ServerSettings>;
    providers: Atom.Writable<readonly ServerProvider[], readonly ServerProvider[]>;
    permitted: Atom.Writable<boolean, boolean>;
  },
  request: vi.fn(),
}));

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => mocks.state.settings,
    providersValueAtom: () => mocks.state.providers,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.request }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({ permissionAtom: () => mocks.state.permitted }),
}));

import { useNextPromptSuggestion } from "./useNextPromptSuggestion";

function deferred() {
  let resolve!: (value: { _tag: "Success"; value: { suggestion: string | null } }) => void;
  const promise = new Promise<Parameters<typeof resolve>[0]>((resume) => {
    resolve = resume;
  });
  return {
    promise,
    finish: (suggestion: string) => resolve({ _tag: "Success", value: { suggestion } }),
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.request = vi.fn();
  const instanceId = ProviderInstanceId.make("codex");
  mocks.state = {
    settings: Atom.make<ServerSettings>({
      ...DEFAULT_SERVER_SETTINGS,
      nextPromptSuggestionsEnabled: true,
      nextPromptSuggestionModelSelection: createModelSelection(instanceId, "test-model"),
    }),
    providers: Atom.make<readonly ServerProvider[]>([
      {
        instanceId,
        enabled: true,
        availability: "available",
        supportsTextGeneration: true,
      } as ServerProvider,
    ]),
    permitted: Atom.make(true),
  };
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe(props: {
    readonly environmentId: string;
    readonly runId: string;
    readonly eligible: boolean;
  }) {
    const suggestion = useNextPromptSuggestion(
      { environmentId: EnvironmentId.make(props.environmentId), threadId: ThreadId.make("thread") },
      RunId.make(props.runId),
      props.eligible,
    );
    return <span>{suggestion}</span>;
  }
  return {
    registry,
    async render(runId = "run-1", eligible = true, environmentId = "host-a") {
      await act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <Probe environmentId={environmentId} runId={runId} eligible={eligible} />
          </RegistryContext>,
        ),
      );
    },
    get suggestion() {
      return container.textContent;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("makes no model request while ineligible, disabled, or without permission", async () => {
  using screen = setup();
  await screen.render("run-1", false);
  expect(mocks.request).not.toHaveBeenCalled();
  screen.registry.set(mocks.state.settings, {
    ...screen.registry.get(mocks.state.settings),
    nextPromptSuggestionsEnabled: false,
  });
  await screen.render();
  expect(mocks.request).not.toHaveBeenCalled();
  screen.registry.set(mocks.state.settings, {
    ...screen.registry.get(mocks.state.settings),
    nextPromptSuggestionsEnabled: true,
  });
  screen.registry.set(mocks.state.permitted, false);
  await screen.render();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("reuses a completed turn's suggestion when the composer becomes eligible again", async () => {
  using screen = setup();
  const response = deferred();
  mocks.request.mockReturnValue(response.promise);
  await screen.render();
  await act(async () => response.finish("Review the diff"));
  expect(screen.suggestion).toBe("Review the diff");
  await screen.render("run-1", false);
  expect(screen.suggestion).toBe("");
  await screen.render();
  expect(screen.suggestion).toBe("Review the diff");
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("isolates environments and ignores a late response from an older run", async () => {
  using screen = setup();
  const old = deferred(),
    latest = deferred(),
    other = deferred();
  mocks.request
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise)
    .mockReturnValueOnce(other.promise);
  await screen.render();
  await screen.render("run-2");
  await screen.render("run-1", true, "host-b");
  await act(async () => {
    other.finish("Host B");
    latest.finish("Current run");
    old.finish("Outdated");
  });
  expect(screen.suggestion).toBe("Host B");
  await screen.render("run-2");
  expect(screen.suggestion).toBe("Current run");
  expect(mocks.request).toHaveBeenCalledTimes(3);
});
