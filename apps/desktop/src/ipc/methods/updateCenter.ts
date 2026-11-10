import { DesktopUpdateCenterChange, DesktopUpdateCenterState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopUpdateCenter } from "../../updates/DesktopUpdateCenter.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CENTER_GET_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCenterState,
  handler: Effect.fn("desktop.ipc.updateCenter.getState")(function* () {
    return yield* (yield* DesktopUpdateCenter).getState;
  }),
});
export const configure = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CENTER_CONFIGURE_CHANNEL,
  payload: DesktopUpdateCenterChange,
  result: DesktopUpdateCenterState,
  handler: Effect.fn("desktop.ipc.updateCenter.configure")(function* (change) {
    return yield* (yield* DesktopUpdateCenter).configure(change);
  }),
});
export const chooseCommand = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CENTER_CHOOSE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCenterState,
  handler: Effect.fn("desktop.ipc.updateCenter.chooseCommand")(function* () {
    return yield* (yield* DesktopUpdateCenter).chooseCommand;
  }),
});
export const check = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CENTER_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCenterState,
  handler: Effect.fn("desktop.ipc.updateCenter.check")(function* () {
    return yield* (yield* DesktopUpdateCenter).check;
  }),
});
export const install = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CENTER_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.updateCenter.install")(function* () {
    return yield* (yield* DesktopUpdateCenter).install;
  }),
});
