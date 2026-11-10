import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { settingsPageLabel } from "@t3tools/shared/i18n/settingsCopy";
import { useUiLanguage } from "../../i18n/useUiLanguage";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { language, t } = useUiLanguage();
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const sourceLabel = SETTINGS_BREADCRUMB_LABELS[normalizedPathname];
  const sectionLabel = sourceLabel && settingsPageLabel(language, normalizedPathname, sourceLabel);

  return (
    <WorkspaceBreadcrumb ariaLabel={t("settings.breadcrumb")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{t("navigation.settings")}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? t("navigation.settings")}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
