import { RegistryContext } from "@effect/atom-react";
import type { DesktopUpdateCenterBridge, DesktopUpdateCenterState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";
import { UpdateCenterSettings } from "../settings/UpdateCenterSettings";
import { DesktopUpdateCenter } from "./DesktopUpdateCenter";

it("shows detection separately from local installation and honors both switches and branch restrictions", async () => {
  const source = {
    status: "current" as const,
    current: "0.1.7",
    latest: "0.1.7",
    message: null,
    url: null,
    checkedAt: "2026-11-09T12:00:00Z",
    majorUpdate: false,
  };
  let state: DesktopUpdateCenterState = {
    supported: true,
    localAllowed: true,
    installing: false,
    preferences: { checkingEnabled: true, quickUpdateEnabled: false, commandPath: null },
    build: {
      artifactVersion: "0.1.7-plus.20261109.3",
      upstreamVersion: "0.1.7",
      repository: "kaku1210/t3code",
      sourceBranch: "develop",
      sourceRevision: "a".repeat(40),
      sourceDirty: true,
      builtAt: "2026-11-09T12:00:00Z",
      platform: "win32",
      arch: "x64",
    },
    upstream: {
      ...source,
      status: "available",
      latest: "1.0.0",
      majorUpdate: true,
      url: "https://github.com/pingdotgg/t3code/releases/tag/v1.0.0",
      releaseNotes: { version: "1.0.0", items: ["Readable update summaries"], totalItems: 1 },
    },
    repository: {
      ...source,
      status: "available",
      current: "a".repeat(40),
      latest: "b".repeat(40),
      commits: [
        {
          sha: "a".repeat(40),
          message: "feat: portable migrations\n\nPreserve the previous installation.",
          url: "https://github.com/kaku1210/t3code/commit/" + "a".repeat(40),
        },
      ],
      commitCount: 1,
    },
    local: {
      ...source,
      status: "available",
      current: "0.1.7-plus.20261109.3",
      latest: "0.1.7-plus.20261109.4",
    },
  };
  const listeners = new Set<(state: DesktopUpdateCenterState) => void>();
  const emit = (change: Partial<DesktopUpdateCenterState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener(state);
  };
  const check = vi.fn(async () => state);
  let rejectInstall!: (error: Error) => void;
  const install = vi.fn(
    () =>
      new Promise<boolean>((_resolve, reject) => {
        rejectInstall = reject;
      }),
  );
  const bridge: DesktopUpdateCenterBridge = {
    getState: async () => state,
    check,
    install,
    configure: async (change) => {
      emit({
        preferences: {
          ...state.preferences,
          checkingEnabled: change.checkingEnabled ?? state.preferences.checkingEnabled,
          quickUpdateEnabled: change.quickUpdateEnabled ?? state.preferences.quickUpdateEnabled,
        },
      });
      return state;
    },
    chooseCommand: async () => state,
    onState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const openExternal = vi.fn(async () => true);
  using _bridge = stubGlobal("desktopBridge", { updateCenter: bridge, openExternal });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <DesktopUpdateCenter />
      <UpdateCenterSettings />
    </RegistryContext.Provider>,
  );
  const toggle = screen.getByRole("button", { name: "Updates", exact: true });
  await expect.element(toggle).toBeVisible();
  await toggle.click();
  await expect
    .element(page.getByRole("heading", { name: "Upstream T3 Code", exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("Major version update", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Readable update summaries", { exact: true }))
    .not.toBeVisible();
  await page.getByText("Release notes", { exact: true }).click();
  await expect.element(page.getByText("Readable update summaries", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("feat: portable migrations", { exact: false }))
    .not.toBeVisible();
  await page.getByText("Update commits", { exact: false }).click();
  await page.getByText("feat: portable migrations", { exact: false }).click();
  await expect
    .element(page.getByText("Preserve the previous installation.", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Open in browser", exact: true }).first().click();
  expect(openExternal).toHaveBeenCalledWith(
    "https://github.com/pingdotgg/t3code/releases/tag/v1.0.0",
  );
  await expect
    .element(page.getByRole("button", { name: "Quick update with AI", exact: true }).first())
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Update upstream with AI", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Sync repository with AI", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Update and restart", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  expect(check).toHaveBeenCalledOnce();
  await act(() =>
    emit({
      preferences: {
        ...state.preferences,
        quickUpdateEnabled: true,
        commandPath: "D:\\Project\\AgentLearn\\Migrate-T3-Code-Plus.cmd",
      },
    }),
  );
  await expect
    .element(page.getByRole("heading", { name: "Prepared local package", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Update and restart", exact: true }).click();
  expect(install).toHaveBeenCalledOnce();
  await act(() => emit({ installing: true }));
  await expect
    .element(
      page.getByText(
        "Preparing the local update. A separate window will show installation progress.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await toggle.click();
  await act(() => {
    emit({ installing: false });
    rejectInstall(new Error("The update coordinator could not start."));
  });
  await expect
    .element(page.getByText("The update coordinator could not start.", { exact: true }))
    .toBeVisible();
  await toggle.click();
  await screen.getByRole("switch", { name: "Check for updates", exact: true }).click();
  await expect.element(toggle).not.toBeInTheDocument();
  expect(document.documentElement.dataset.updateCenterVisible).toBeUndefined();
  await screen.getByRole("switch", { name: "Check for updates", exact: true }).click();
  await expect.element(toggle).toBeVisible();
  await act(() => emit({ localAllowed: false, build: { ...state.build, sourceBranch: "main" } }));
  await expect
    .element(screen.getByRole("switch", { name: "Quick local update", exact: true }))
    .not.toBeInTheDocument();
  await toggle.click();
  await expect
    .element(page.getByRole("heading", { name: "Prepared local package", exact: true }))
    .not.toBeInTheDocument();
});
