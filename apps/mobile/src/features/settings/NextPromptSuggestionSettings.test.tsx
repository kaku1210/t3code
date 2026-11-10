import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ModelOption } from "../../lib/modelOptions";

const mocks = vi.hoisted(() => ({ targets: [] as unknown[], write: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../state/server", () => ({ serverEnvironment: { providersValueAtom: () => [] } }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({ selectedTargets: mocks.targets }),
}));
vi.mock("./useSettingsWriter", () => ({ useSettingsWriter: () => mocks.write }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    label: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.label}
      checked={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    accessibilityLabel: string;
    actions: readonly {
      id: string;
      title: string;
      subactions?: readonly { id: string; title: string }[];
    }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) => (
    <div>
      <select
        aria-label={props.accessibilityLabel}
        onChange={(event) => props.onPressAction({ nativeEvent: { event: event.target.value } })}
      >
        {props.actions
          .flatMap((action) => action.subactions ?? [action])
          .map((action) => (
            <option key={action.id} value={action.id}>
              {action.title}
            </option>
          ))}
      </select>
      {props.children}
    </div>
  ),
}));

import { UiLanguageContext } from "../../i18n/useUiLanguage";
import { NextPromptSuggestionSettings } from "./NextPromptSuggestionSettings";

vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: (config: ServerConfig) => [
    {
      key: "codex/model",
      label: "Codex model",
      providerKey: "codex",
      providerLabel: "Codex",
      providerDriver: "codex",
      subtitle: "",
      isDefault: false,
      isLegacy: false,
      selection: config.settings.nextPromptSuggestionModelSelection!,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
            currentValue: "low",
          },
        ],
      }),
    } satisfies ModelOption,
  ],
  groupByProvider: (options: readonly ModelOption[]) => [
    { providerKey: "codex", providerLabel: "Codex", models: options },
  ],
}));

it("shows Codex's reasoning selector without a role hint and writes only the chosen environment", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.write = vi.fn().mockResolvedValue(undefined);
  mocks.targets = ["host-a", "host-b"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        nextPromptSuggestionModelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "test-model",
          [{ id: "serviceTier", value: "standard" }],
        ),
      },
    },
  }));
  const container = document.createElement("div");
  const root = createRoot(container);
  using _cleanup = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () =>
    root.render(
      <UiLanguageContext value="zh-CN">
        <NextPromptSuggestionSettings />
      </UiLanguageContext>,
    ),
  );
  const efforts = container.querySelectorAll<HTMLSelectElement>('select[aria-label="推理强度"]');
  expect(efforts.length).toBe(2);
  await act(async () => {
    efforts[1]!.value = "high";
    efforts[1]!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.write.mock.calls[0]?.[1]).toEqual([
    {
      environmentId: "host-b",
      patch: {
        nextPromptSuggestionModelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "test-model",
          [
            { id: "serviceTier", value: "standard" },
            { id: "reasoningEffort", value: "high" },
          ],
        ),
      },
    },
  ]);
});
