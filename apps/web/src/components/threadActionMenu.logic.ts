import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import { translate } from "@t3tools/shared/i18n/messages";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly language?: UiLanguage;
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  const t = translate.bind(null, options.language ?? "en");
  return [
    {
      id: "copy",
      label: t("common.copy"),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [{ id: "copy-path" as const, label: t("thread.actions.path"), icon: "folder" }]
          : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: t("thread.actions.branch"), icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: t("project.settings"), icon: "settings" }]
      : []),
    {
      id: "discard",
      label: t("thread.actions.discardDraft"),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly language?: UiLanguage;
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const t = translate.bind(null, state.language ?? "en");
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: t("thread.actions.find"), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: t("thread.actions.newOnBranch", { branch: state.branch }),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: t("thread.actions.unpin"), icon: "pin-off" }
            : { id: "pin" as const, label: t("thread.actions.pin"), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: t("thread.actions.unsettle"), icon: "circle-check" }
            : { id: "settle" as const, label: t("thread.actions.settle"), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: t("thread.actions.wake"), icon: "clock" }
            : {
                id: "snooze" as const,
                label: t("thread.actions.snooze"),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: t("thread.actions.snoozeCustom"),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    { id: "rename", label: t("thread.actions.rename"), icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: t(
              state.isRegeneratingTitle
                ? "thread.actions.regenerating"
                : "thread.actions.regenerate",
            ),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: t("thread.actions.markUnread"), icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: t("thread.actions.shareGuest"), icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? t("thread.actions.showAllProjects")
              : t("thread.actions.filterProject", { project: state.projectFilter.label }),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: t("thread.actions.promote"),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: t("thread.actions.autoSettle"),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: t("common.enabled"),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: t("common.disabled"),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: t("common.copy"),
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: t("thread.actions.path"), icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: t("thread.actions.branch"), icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: t("thread.actions.copyThread"), icon: "message-square" },
        { id: "copy-thread-id", label: t("thread.actions.copyId"), icon: "hash" },
      ],
    },
    { id: "project-settings", label: t("project.settings"), icon: "settings" },
    {
      id: "archive",
      label: t("thread.actions.archive"),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: t("common.delete"),
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
