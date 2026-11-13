import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeQuitShortcutHandler,
  QUIT_DOUBLE_PRESS_MS,
  QUIT_HOLD_DURATION_MS,
  QUIT_HOLD_HINT_MS,
} from "./QuitHold.ts";
import type { QuitHoldKeyInput } from "./QuitHold.ts";
import type { QuitConfirmationMode, QuitShortcutHintEvent } from "@t3tools/contracts";

const DOUBLE_CLICK_DOWN = { state: "down", mode: "double-click" } as const;
const HOLD_DOWN = { state: "down", mode: "hold" } as const;
const UP = { state: "up" } as const;

function makeInput(overrides: Partial<QuitHoldKeyInput>): QuitHoldKeyInput {
  return {
    type: "keyDown",
    key: "q",
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

function makeHarness(options?: {
  mode?: QuitConfirmationMode;
  platform?: NodeJS.Platform;
  getMode?: () => Promise<QuitConfirmationMode>;
}) {
  const notifications: Array<QuitShortcutHintEvent> = [];
  const concealWindow = vi.fn();
  const quit = vi.fn();
  const handler = makeQuitShortcutHandler({
    platform: options?.platform ?? "darwin",
    getMode: options?.getMode ?? (() => Promise.resolve(options?.mode ?? "hold")),
    notify: (event) => notifications.push(event),
    concealWindow,
    quit,
  });
  const preventDefault = vi.fn();
  const send = async (input: QuitHoldKeyInput) => {
    handler({ preventDefault }, input);
    await Promise.resolve();
    await Promise.resolve();
  };
  const holdFor = async (
    durationMs: number,
    repeatOverrides: Partial<QuitHoldKeyInput> = {},
    intervalMs = 100,
  ) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += intervalMs) {
      vi.advanceTimersByTime(intervalMs);
      await send(makeInput({ isAutoRepeat: true, ...repeatOverrides }));
    }
  };
  return { notifications, concealWindow, quit, preventDefault, send, holdFor };
}

describe("makeQuitShortcutHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("honors direct mode when the key is released before its mode read settles", async () => {
    let resolveMode: ((mode: QuitConfirmationMode) => void) | undefined;
    const harness = makeHarness({
      getMode: () =>
        new Promise((resolve) => {
          resolveMode = resolve;
        }),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));

    resolveMode?.("direct");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([]);
  });

  it("does not arm hold mode after a released key's mode read settles", async () => {
    let resolveMode: ((mode: QuitConfirmationMode) => void) | undefined;
    const harness = makeHarness({
      getMode: () =>
        new Promise((resolve) => {
          resolveMode = resolve;
        }),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));

    resolveMode?.("hold");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);
  });

  it("quits on a quick second press in double-click mode", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 100);
    await harness.send(makeInput({}));

    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("does not quit on a quick second press in hold mode", async () => {
    const harness = makeHarness({ mode: "hold" });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 100);
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));

    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);
  });

  it("shows the hold hint after the hint delay and quits only after the full hold", async () => {
    const harness = makeHarness({ mode: "hold", platform: "win32" });
    const ctrlQ = { meta: false, control: true };
    await harness.send(makeInput(ctrlQ));
    // A single press must still reach the page, so shortcut recorders can capture Ctrl+Q.
    expect(harness.preventDefault).not.toHaveBeenCalled();

    await harness.holdFor(QUIT_HOLD_HINT_MS - 100, ctrlQ);
    expect(harness.preventDefault).toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);

    await harness.holdFor(100, ctrlQ);
    expect(harness.notifications).toEqual([HOLD_DOWN]);

    await harness.holdFor(QUIT_HOLD_DURATION_MS - QUIT_HOLD_HINT_MS - 100, ctrlQ);
    expect(harness.quit).not.toHaveBeenCalled();

    await harness.holdFor(100, ctrlQ);
    await harness.send(makeInput({ ...ctrlQ, type: "keyUp" }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("discards a stale mode resolution from a superseded press", async () => {
    const resolvers: Array<(mode: QuitConfirmationMode) => void> = [];
    const harness = makeHarness({
      getMode: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS + 100);
    await harness.send(makeInput({}));
    expect(resolvers).toHaveLength(2);

    resolvers[0]?.("direct");
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.quit).not.toHaveBeenCalled();

    resolvers[1]?.("hold");
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("does not count an interrupted press toward a double press", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ shift: true }));
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP, DOUBLE_CLICK_DOWN]);
  });
});
