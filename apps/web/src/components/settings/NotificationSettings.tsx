import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import type { MessageKey } from "@t3tools/shared/i18n/messages";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const notificationModeMessages = {
  off: "settings.notifications.off",
  notifications: "settings.notifications.system",
  sound: "settings.notifications.sound",
  "notifications-and-sound": "settings.notifications.both",
} as const;

export function NotificationSettings() {
  const { t } = useUiLanguage();
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<MessageKey | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={t(permissionMessage ?? "settings.notifications.description")}
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage("settings.notifications.secureContext");
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage("settings.notifications.unavailable");
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage("settings.notifications.permission");
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("settings.notifications.title")}
          >
            <SelectValue>{t(notificationModeMessages[mode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(notificationModeMessages).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
