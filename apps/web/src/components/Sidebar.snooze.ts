import type { EnvironmentId } from "@t3tools/contracts";
import type { SnoozePresetSetting, TimestampFormat } from "@t3tools/contracts/settings";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import {
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { translate } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export { snoozeWakeLabel, type SnoozePreset };

export function formatSnoozeWakeDuration(value: string, language: UiLanguage): string {
  if (language === "en") return value;
  if (value === "now") return translate(language, "time.now");
  const count = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  return translate(
    language,
    unit === "m" ? "time.minutes" : unit === "h" ? "time.hours" : "time.days",
    { count },
  );
}

/** The snooze menu for a thread, from its environment's presets, read when the menu opens. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
  language: UiLanguage = "en",
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, {
    ...snoozeOptions(timestampFormat, environmentId),
    ...(language === "zh-CN"
      ? { formatLabel: formatChineseSnoozePreset, weekdayLocale: language }
      : {}),
  });
}

function formatChineseSnoozePreset(setting: SnoozePresetSetting, daysAhead: number, wake: Date) {
  const t = translate.bind(null, "zh-CN");
  if (setting.kind === "after") {
    const { minutes } = setting;
    if (minutes % 1440 === 0) return t("thread.snooze.inDays", { count: minutes / 1440 });
    if (minutes % 60 === 0) return t("thread.snooze.inHours", { count: minutes / 60 });
    return t("thread.snooze.inMinutes", { count: minutes });
  }
  if (daysAhead === 0) {
    const hour = wake.getHours();
    return t(
      hour < 12
        ? "thread.snooze.morning"
        : hour < 17
          ? "thread.snooze.afternoon"
          : "thread.snooze.evening",
    );
  }
  if (daysAhead === 1) return t("thread.snooze.tomorrow");
  if (setting.day === "monday") return t("thread.snooze.nextWeek");
  const weekday = wake.toLocaleDateString("zh-CN", { weekday: "short" });
  return daysAhead === 7 ? t("thread.snooze.nextWeekday", { weekday }) : weekday;
}

/** A shown menu choice as picked; see the shared `pickSnoozePreset`. */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): SnoozePreset | undefined {
  const picked = pickSharedSnoozePreset({
    shown,
    id,
    now: new Date(),
    ...snoozeOptions(timestampFormat, environmentId),
  });
  if (!picked) {
    toastManager.add({
      type: "warning",
      title: "Could not snooze thread",
      description: "That snooze time has passed. Choose another time.",
    });
  }
  return picked;
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat),
  };
}
