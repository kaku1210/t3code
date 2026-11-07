import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";
import {
  DEFAULT_UI_LANGUAGE_PREFERENCE,
  type UiLanguagePreference,
} from "@t3tools/contracts/settings";
import { resolveUiLanguage, type UiLanguage } from "@t3tools/shared/uiLanguage";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
    readonly applyLanguage: (preference: UiLanguagePreference) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const menuCopy = {
  file: ["File", "文件"],
  edit: ["Edit", "编辑"],
  view: ["View", "视图"],
  window: ["Window", "窗口"],
  help: ["Help", "帮助"],
  settings: ["Settings...", "设置…"],
  checkForUpdates: ["Check for Updates...", "检查更新…"],
  closeWindow: ["Close Window", "关闭窗口"],
  quit: ["Quit", "退出"],
  undo: ["Undo", "撤销"],
  redo: ["Redo", "重做"],
  cut: ["Cut", "剪切"],
  copy: ["Copy", "复制"],
  paste: ["Paste", "粘贴"],
  pasteAsText: ["Paste as Text", "粘贴为纯文本"],
  delete: ["Delete", "删除"],
  selectAll: ["Select All", "全选"],
  reload: ["Reload", "重新加载"],
  forceReload: ["Force Reload", "强制重新加载"],
  devTools: ["Toggle Developer Tools", "显示或隐藏开发者工具"],
  actualSize: ["Actual Size", "实际大小"],
  zoomIn: ["Zoom In", "放大"],
  zoomOut: ["Zoom Out", "缩小"],
  fullScreen: ["Toggle Full Screen", "切换全屏"],
  minimize: ["Minimize", "最小化"],
  zoomWindow: ["Zoom", "缩放窗口"],
} as const;

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const runMainContentsCommand = Effect.fn("desktop.menu.runMainContentsCommand")(function* (
  command: DesktopWindow.MainWindowContentsCommand,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.runMainContentsCommand(command);
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `T3 Code ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason.value,
      buttons: ["OK"],
    });
    return;
  }

  // Opening a window before backend confirmation can strand it on failed auth bootstrap.
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.activate;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

/** @public */
export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  let appliedLanguage: UiLanguage | undefined;
  const applyLanguage = Effect.fn("desktop.menu.applyLanguage")(function* (
    preference: UiLanguagePreference,
  ) {
    const language = resolveUiLanguage(
      preference,
      preference === "system" ? yield* electronApp.systemLocale : null,
    );
    if (appliedLanguage === language) return;
    const t = (key: keyof typeof menuCopy) => menuCopy[key][language === "zh-CN" ? 1 : 0];
    const localizedRole = (key: keyof typeof menuCopy) =>
      language === "zh-CN" ? { label: t(key) } : {};
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    // Chromium and the renderer already handle this chord; injecting another paste duplicates text.
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) return;
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const mainContentsClick = (command: DesktopWindow.MainWindowContentsCommand) => () => {
      runMenuEffect(command, runMainContentsCommand(command));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.displayName,
        submenu: [
          { role: "about", label: `About ${environment.displayName}` },
          {
            label: t("checkForUpdates"),
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: t("settings"),
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `Hide ${environment.displayName}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${environment.displayName}` },
        ],
      });
    }

    template.push(
      {
        label: t("file"),
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: t("settings"),
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          // Cmd/Ctrl+W belongs to the renderer's tab close; it must never close the window.
          environment.platform === "darwin"
            ? { label: t("closeWindow"), click: (_item, window) => window?.close() }
            : { role: "quit", ...localizedRole("quit") },
        ],
      },
      {
        label: t("edit"),
        submenu: [
          { role: "undo", ...localizedRole("undo") },
          { role: "redo", ...localizedRole("redo") },
          { type: "separator" },
          { role: "cut", ...localizedRole("cut") },
          { role: "copy", ...localizedRole("copy") },
          { role: "paste", ...localizedRole("paste") },
          {
            label: t("pasteAsText"),
            accelerator: "CmdOrCtrl+Shift+V",
            click: pasteAsTextClick,
          },
          { role: "delete", ...localizedRole("delete") },
          { type: "separator" },
          { role: "selectAll", ...localizedRole("selectAll") },
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                {
                  label: "Speech",
                  submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }],
                },
              ]
            : []),
        ],
      },
      {
        label: t("view"),
        submenu: [
          /* Native reload/DevTools/zoom roles target focused guests; these commands must target the app. */
          { label: t("reload"), accelerator: "CmdOrCtrl+R", click: mainContentsClick("reload") },
          {
            label: t("forceReload"),
            accelerator: "Shift+CmdOrCtrl+R",
            click: mainContentsClick("forceReload"),
          },
          {
            label: t("devTools"),
            accelerator: environment.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
            click: mainContentsClick("toggleDevTools"),
          },
          { type: "separator" },
          { label: t("actualSize"), accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: t("zoomIn"), accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: t("zoomIn"),
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          ...(environment.platform === "darwin"
            ? [
                {
                  label: t("zoomIn"),
                  accelerator: "CmdOrCtrl+Shift+=",
                  visible: false,
                  click: zoomClick("in"),
                },
              ]
            : []),
          { label: t("zoomOut"), accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          // Keypad codes do not match number-row accelerators.
          {
            label: t("actualSize"),
            accelerator: "CmdOrCtrl+num0",
            visible: false,
            click: zoomClick("reset"),
          },
          {
            label: t("zoomIn"),
            accelerator: "CmdOrCtrl+numadd",
            visible: false,
            click: zoomClick("in"),
          },
          {
            label: t("zoomOut"),
            accelerator: "CmdOrCtrl+numsub",
            visible: false,
            click: zoomClick("out"),
          },
          { type: "separator" },
          { role: "togglefullscreen", ...localizedRole("fullScreen") },
        ],
      },
      {
        // Electron's default Window submenu adds a Ctrl+W close role off macOS.
        role: "windowMenu",
        ...localizedRole("window"),
        submenu: [
          { role: "minimize", ...localizedRole("minimize") },
          { role: "zoom", ...localizedRole("zoomWindow") },
          ...(environment.platform === "darwin"
            ? [{ type: "separator" as const }, { role: "front" as const }]
            : []),
        ],
      },
      {
        role: "help",
        ...localizedRole("help"),
        submenu: [
          {
            label: t("checkForUpdates"),
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
    appliedLanguage = language;
  });

  const configure = clientSettings.get.pipe(
    Effect.catchTags({
      DesktopClientSettingsReadError: (error) =>
        logMenuError("Could not read the desktop menu language preference", { error }).pipe(
          Effect.as(Option.none()),
        ),
    }),
    Effect.flatMap((settings) =>
      applyLanguage(
        Option.match(settings, {
          onNone: () => DEFAULT_UI_LANGUAGE_PREFERENCE,
          onSome: (value) => value.uiLanguage,
        }),
      ),
    ),
    Effect.withSpan("desktop.menu.configure"),
  );

  return DesktopApplicationMenu.of({
    configure,
    applyLanguage,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
