import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";

import { translate } from "../../i18n/messages";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(
  state: DesktopSnapShotState | null,
  enabled: boolean,
  language: UiLanguage = "en",
): string {
  const t = translate.bind(null, language);
  if (!state) return t("settings.snapshots.loading");
  if (state.mode === "unavailable") return state.message ?? t("settings.snapshots.unavailable");
  if (!enabled) return t("settings.snapshots.disabled");
  return snapShotSetupSummary(state, enabled, language);
}

export function snapShotSetupSummary(
  state: DesktopSnapShotState,
  enabled: boolean,
  language: UiLanguage = "en",
): string {
  const t = translate.bind(null, language);
  if (state.message) return t("settings.snapshots.needsAttention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? t("settings.snapshots.checkCaptureAccess")
      : t("settings.snapshots.installHelper");
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return t("settings.snapshots.setUpActiveWindow");
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? t("settings.snapshots.checkCaptureAccess")
      : t("settings.snapshots.installHelper");
  if (captureSetupBackend(state) === "picker") return t("settings.snapshots.manualOnly");
  if (!enabled) return t("settings.snapshots.enableCapture");
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? t("settings.snapshots.connectingShortcut")
      : t("settings.snapshots.waitForPermission");
  if (state.shortcutVerified) return t("settings.snapshots.ready");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return t("settings.snapshots.shortcutOtherApp");
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return t("settings.snapshots.shortcutOtherApp");
  if (state.shortcutRegistered)
    return state.shortcutLabel ? t("settings.snapshots.ready") : t("settings.snapshots.saved");
  return t("settings.snapshots.finishSetup");
}

export function snapShotShortcutStatus(
  state: DesktopSnapShotState | null,
  language: UiLanguage = "en",
): string | null {
  const t = translate.bind(null, language);
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending) return t("settings.snapshots.permissionPrompt");
  if (state.shortcutRegistered)
    return state.mode === "portal" ? null : t("settings.snapshots.savedDetail");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(
  state: DesktopSnapShotState | null,
  language: UiLanguage = "en",
): string {
  const t = translate.bind(null, language);
  if (!state) return t("settings.snapshots.setup");
  if (captureSetupAccessReady(state)) return t("settings.snapshots.manage");
  const desktop = captureSetupDesktopName(state);
  return desktop
    ? t("settings.snapshots.setupDesktop", { desktop })
    : t("settings.snapshots.setup");
}

export function snapShotSetupComplete(
  state: DesktopSnapShotState | null,
  includeAccessibility: boolean,
): boolean {
  if (state?.windows) return true;
  return (
    state?.macPermissions !== undefined &&
    captureSetupAccessReady(state) &&
    captureSetupMacPermissionsReady(state, includeAccessibility) &&
    state.shortcutRegistered
  );
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotFeedbackUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? "Capture effects aren't available on this desktop."
      : "Install or update the capture helper to enable effects.";
  if (state.linuxBackend === "niri") return "Capture effects aren't available on Niri.";
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? "Capture effects aren't available on this desktop."
      : "Install or update the capture helper to enable effects.";
  return state.linuxBackend === "gnome-extension"
    ? "Update the GNOME extension, then sign out and back in to enable effects."
    : captureSetupBackend(state) === "gnome"
      ? "Finish extension setup to enable effects."
      : "Capture effects aren't available on this desktop.";
}

export function snapShotDescription(
  state: DesktopSnapShotState | null,
  language: UiLanguage = "en",
): string {
  const t = translate.bind(null, language);
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? t("settings.snapshots.manualDescription")
    : t("settings.snapshots.description");
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return "This desktop only provides a screenshot.";
  return undefined;
}

export function snapShotUnavailableMessage(
  hasBridge: boolean,
  language: UiLanguage = "en",
): string | undefined {
  const t = translate.bind(null, language);
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? t("settings.snapshots.updateDesktop")
    : t("settings.browser.desktopOnly");
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
