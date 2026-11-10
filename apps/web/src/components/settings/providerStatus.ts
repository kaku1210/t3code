import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";

import { translate } from "@t3tools/shared/i18n/messages";

export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  neutral: {
    dot: "bg-muted-foreground",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

// Antigravity's local health check verifies installation, not Google sign-in.
// API-key and Agent Platform warnings still need attention.
function isAntigravitySignInUnchecked(provider: ServerProvider): boolean {
  return (
    provider.driver === "antigravity" &&
    provider.installed &&
    provider.status === "warning" &&
    provider.auth.status === "unknown" &&
    (provider.auth.type === undefined ||
      provider.auth.type === "oauth-personal" ||
      provider.auth.type === "oauth-business")
  );
}

export function getProviderStatusKey(provider: ServerProvider | undefined): ProviderStatusKey {
  if (provider && !provider.enabled) return "disabled";
  if (provider && isAntigravitySignInUnchecked(provider)) return "neutral";
  return provider?.status ?? "warning";
}

const PROVIDER_DIAGNOSTIC_KEYS = [
  "provider.diagnostic.claudeLogin",
  "provider.diagnostic.antigravityInstall",
  "provider.diagnostic.antigravityMissing",
  "provider.diagnostic.acpSession",
] as const;

export function getProviderSummary(
  provider: ServerProvider | undefined,
  language: UiLanguage = "en",
) {
  const t = translate.bind(null, language);
  if (!provider) {
    return {
      headline: t("provider.status.checking"),
      detail: t("provider.status.checkingDetail"),
    };
  }
  const diagnostic = PROVIDER_DIAGNOSTIC_KEYS.find(
    (key) => translate("en", key) === provider.message,
  );
  const detail = diagnostic ? t(diagnostic) : (provider.message ?? null);
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: t("common.disabled"),
      detail: detail ?? t("provider.status.disabledDetail"),
    };
  }
  if (!provider.installed) {
    return {
      headline: t("provider.status.notFound"),
      detail: detail ?? t("provider.status.notFoundDetail"),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const method = provider.auth.label ?? provider.auth.type;
    const status = t("provider.status.unauthenticated");
    return {
      headline: method ? t("provider.status.withAuth", { status, method }) : status,
      detail,
    };
  }
  if (isAntigravitySignInUnchecked(provider)) {
    return { headline: t("provider.status.unchecked"), detail };
  }
  if (provider.status === "warning") {
    return {
      headline: t("provider.status.warning"),
      detail: detail ?? t("provider.status.warningDetail"),
    };
  }
  if (provider.status === "error") {
    return {
      headline: t("provider.status.error"),
      detail: detail ?? t("provider.status.errorDetail"),
    };
  }
  if (provider.auth.status === "authenticated") {
    const method = provider.auth.label ?? provider.auth.type;
    const status = t("provider.status.authenticated");
    return {
      headline: method ? t("provider.status.withAuth", { status, method }) : status,
      detail,
    };
  }
  return { headline: t("provider.status.available"), detail };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  graceful: "settings.providerCard.limitedSupport",
  unsupported: "provider.version.unsupported",
  broken: "provider.version.broken",
} as const;

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
  language: UiLanguage = "en",
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const t = translate.bind(null, language);
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    // Latest package versions cannot be updated into recommendations requiring another package.
    const isAlreadyLatest = advisory?.status === "current";
    return {
      title: t(COMPATIBILITY_TITLES[compatibility.status]),
      detail:
        compatibility.message ??
        (recommendation
          ? t("provider.version.use", { version: recommendation })
          : t("provider.version.update")),
      updateCommand:
        targetVersion || latestIsIncompatible || isAlreadyLatest
          ? null
          : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const label = t("provider.version.available");
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (versionLabel
        ? t("provider.version.install", { label, version: versionLabel })
        : t("provider.version.installLatest", { label })),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}
