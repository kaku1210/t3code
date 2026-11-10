import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  TextGenerationError,
  ThreadId,
  type ThreadPromptSuggestionInput,
  type ThreadPromptSuggestionResult,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a new draft does not load its reserved thread before the server lists it", async () => {
  // AppRoot shares its registry, so release the connection before the next fixture.
  using _registry = { [Symbol.dispose]: () => appAtomRegistry.reset() };
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("shows why there is no prompt suggestion only after the request finishes", async () => {
  const thread = threadWithHistory("suggestion-usage-limit", 1);
  let resolveResponse!: (result: ThreadPromptSuggestionResult) => void;
  const response = new Promise<ThreadPromptSuggestionResult>((resolve) => {
    resolveResponse = resolve;
  });
  const suggestPrompt = vi.fn(() => Effect.promise(() => response));
  using _registry = { [Symbol.dispose]: () => appAtomRegistry.reset() };
  using _environment = installFakeEnvironment([thread], suggestPrompt);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    uiLanguage: "zh-CN",
    composerPlaceholder: "输入下一条消息",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  const hint = page.getByText("输入下一条消息", { exact: true });
  const status = page.getByText("暂无建议 · 所选模型额度已用尽，可切换推荐模型", {
    exact: true,
  });
  await expect.element(hint).toBeVisible();
  await vi.waitFor(() =>
    expect(suggestPrompt).toHaveBeenCalledWith({ threadId: thread.id, runId: thread.runs[0]!.id }),
  );
  await expect.element(status).not.toBeInTheDocument();

  resolveResponse({ suggestion: null, emptyReason: "quota-exhausted" });
  await expect.element(status).toBeVisible();
  await expect.element(hint).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "重试", exact: true }))
    .not.toBeInTheDocument();
  expect(document.querySelector("[data-composer-prompt-suggestion]")).toBeNull();
});

it("retries a failed prompt suggestion once even when activated twice", async () => {
  const thread = threadWithHistory("suggestion-retry", 1);
  let resolveRetry!: (result: ThreadPromptSuggestionResult) => void;
  const retryResponse = new Promise<ThreadPromptSuggestionResult>((resolve) => {
    resolveRetry = resolve;
  });
  const suggestPrompt = vi
    .fn<
      (
        input: ThreadPromptSuggestionInput,
      ) => Effect.Effect<ThreadPromptSuggestionResult, TextGenerationError>
    >(() => Effect.promise(() => retryResponse))
    .mockReturnValueOnce(
      Effect.fail(
        new TextGenerationError({
          operation: "generatePromptSuggestion",
          detail: "The recommendation request failed.",
        }),
      ),
    );
  using _registry = { [Symbol.dispose]: () => appAtomRegistry.reset() };
  using _environment = installFakeEnvironment([thread], suggestPrompt);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    uiLanguage: "zh-CN",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await expect
    .element(page.getByText("建议生成失败 · 请检查推荐模型或连接", { exact: true }))
    .toBeVisible();
  expect(suggestPrompt).toHaveBeenCalledTimes(1);

  const retry = page.getByRole("button", { name: "重试", exact: true });
  const button = retry.element() as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  // Both clicks occur before React can render the disabled button.
  await act(() => {
    button.click();
    button.click();
  });
  await expect.element(retry).toBeDisabled();
  await expect.element(page.getByText("正在重试推荐…", { exact: true })).toBeVisible();

  const suggestion = "先跑一下刚才改动涉及的测试。";
  resolveRetry({ suggestion });
  await expect.element(page.getByRole("button", { name: suggestion, exact: true })).toBeVisible();
  await expect.element(retry).not.toBeInTheDocument();
  expect(suggestPrompt).toHaveBeenCalledTimes(2);
  expect(suggestPrompt).toHaveBeenLastCalledWith({
    threadId: thread.id,
    runId: thread.runs[0]!.id,
  });
});
