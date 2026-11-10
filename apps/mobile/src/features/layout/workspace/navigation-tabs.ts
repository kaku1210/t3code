import { useAtomValue } from "@effect/atom-react";
import { useUiLanguage } from "../../../i18n/useUiLanguage";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import {
  NAVIGATION_TAB_LABELS,
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  enabledNavigationTabs,
  type NavigationTab,
} from "./navigation-tab-order";
import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { mobilePreferencesAtom } from "../../../state/preferences";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { resolveWorkspaceTabOrder } from "./workspace-tabs-state";

const WORKSPACE_TAB_LABELS = {
  ...NAVIGATION_TAB_LABELS,
  ...(Platform.OS === "ios" ? { threads: "Chats", pullRequests: "PRs" } : {}),
};

/** Resolves native navigation labels on each language change without rebuilding tab controllers. */
export function useWorkspaceTabLabels() {
  const { text } = useUiLanguage();
  return Object.fromEntries(
    Object.entries(WORKSPACE_TAB_LABELS).map(([key, value]) => [key, text(value)]),
  ) as Record<keyof typeof WORKSPACE_TAB_LABELS, string>;
}

export const NAVIGATION_TAB_ICONS = {
  threads: "text.bubble",
  pullRequests: PullRequestGlyph.pullRequest,
  usage: "chart.bar.xaxis",
} as const satisfies Readonly<Record<NavigationTab, AppSymbolName>>;

export function useNavigationTabOrder() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.navigationTabOrder
    : undefined;
  return resolveWorkspaceTabOrder(saved);
}

export function useHiddenNavigationTabs() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.hiddenNavigationTabs
    : undefined;
  return navigationCustomizationAvailable() ? resolveHiddenNavigationTabs(saved) : [];
}

export function useEnabledNavigationTabs() {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  return enabledNavigationTabs(order, hidden);
}
