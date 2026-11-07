import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
import { type LucideIcon, LockIcon, PenLineIcon, ShieldOffIcon, SparklesIcon } from "lucide-react";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import { translate, type MessageKey } from "../../i18n/messages";

const runtimeModeMessages = {
  "approval-required": ["permission.supervised", "permission.supervisedDescription"],
  "auto-accept-edits": ["permission.autoAcceptEdits", "permission.autoAcceptEditsDescription"],
  auto: ["permission.auto", "permission.autoDescription"],
  "full-access": ["permission.fullAccess", "permission.fullAccessDescription"],
} as const satisfies Record<RuntimeMode, readonly [MessageKey, MessageKey]>;

export function runtimeModeCopy(language: UiLanguage, mode: RuntimeMode) {
  const [label, description] = runtimeModeMessages[mode];
  return { label: translate(language, label), description: translate(language, description) };
}

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    ...runtimeModeCopy("en", "approval-required"),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    ...runtimeModeCopy("en", "auto-accept-edits"),
    icon: PenLineIcon,
  },
  auto: {
    ...runtimeModeCopy("en", "auto"),
    icon: SparklesIcon,
  },
  "full-access": {
    ...runtimeModeCopy("en", "full-access"),
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
) {
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    const disabledReason = managedRuntimeModeDenial(managedPolicy, mode);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
