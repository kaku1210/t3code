import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { Preferences } from "../persistence/mobile-preferences";

const mocks = vi.hoisted(() => ({
  locale: "en-US",
  onAppStateChange: null as ((state: string) => void) | null,
  saved: [] as Partial<Preferences>[],
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.onAppStateChange = listener;
      return {
        remove: () => {
          mocks.onAppStateChange = null;
        },
      };
    },
  },
}));
vi.mock("../state/preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const preferences = Atom.make(AsyncResult.success<Preferences>({ uiLanguage: "en" }));
  return {
    mobilePreferencesAtom: preferences,
    updateMobilePreferencesAtom: Atom.fn((patch: Partial<Preferences>, get) =>
      Effect.sync(() => {
        mocks.saved.push(patch);
        const current = get(preferences);
        get.set(
          preferences,
          AsyncResult.success({
            ...(AsyncResult.isSuccess(current) ? current.value : {}),
            ...patch,
          }),
        );
      }),
    ),
  };
});
vi.mock("../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    disabled: boolean;
    selected: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled} aria-pressed={props.selected} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../features/settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

import { LanguageSection } from "../features/settings/appearance/sections/LanguageSection";
import { UiLanguageProvider } from "./UiLanguageProvider";
import { useUiLanguage } from "./useUiLanguage";

function Probe() {
  const { language, text } = useUiLanguage();
  return <output data-language={language}>{text("Chat")}</output>;
}

it("switches interface copy through saved choices and follows system changes only in system mode", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.locale = "en-US";
  mocks.saved = [];
  const originalOptions = Intl.DateTimeFormat().resolvedOptions();
  using _locale = vi
    .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
    .mockImplementation(() => ({ ...originalOptions, locale: mocks.locale }));
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _cleanup = {
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      registry.dispose();
    },
  };
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <UiLanguageProvider>
          <LanguageSection />
          <Probe />
        </UiLanguageProvider>
      </RegistryContext>,
    ),
  );
  const choose = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const language = () => container.querySelector("output")?.getAttribute("data-language");
  expect(language()).toBe("en");
  await choose("简体中文");
  expect(language()).toBe("zh-CN");
  expect(container.querySelector("output")?.textContent).toBe("聊天");
  await choose("English");
  mocks.locale = "zh-CN";
  await act(async () => mocks.onAppStateChange?.("active"));
  expect(language()).toBe("en");
  expect(container.querySelector("output")?.textContent).toBe("Chat");
  await choose("Follow system");
  expect(language()).toBe("zh-CN");
  mocks.locale = "en-US";
  await act(async () => mocks.onAppStateChange?.("active"));
  expect(language()).toBe("en");
  expect(mocks.saved).toEqual([
    { uiLanguage: "zh-CN" },
    { uiLanguage: "en" },
    { uiLanguage: "system" },
  ]);
});
