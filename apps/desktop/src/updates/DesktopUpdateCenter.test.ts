import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { DesktopBuildInfo, type DesktopUpdateCenterState } from "@t3tools/contracts";
import * as Electron from "electron";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { make } from "./DesktopUpdateCenter.ts";
import { PortableUpdateManifest } from "./updateCenterSources.ts";

vi.mock("electron", () => ({ net: { fetch: vi.fn() }, app: {} }));
const encodePackageInfo = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ t3codeBuildInfo: DesktopBuildInfo })),
);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(PortableUpdateManifest));
const buildInfo = (sourceBranch: string): DesktopBuildInfo => ({
  artifactVersion: "0.1.7-plus.20261109.3",
  upstreamVersion: "0.1.7",
  repository: "kaku1210/t3code",
  sourceBranch,
  sourceRevision: "a".repeat(40),
  sourceDirty: true,
  builtAt: "2026-11-09T00:00:00Z",
  platform: "win32",
  arch: "x64",
});
const githubCommit = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/kaku1210/t3code/commit/${sha}`,
  commit: { message },
});

const fixture = Effect.fn("updateCenterTest.fixture")(function* (
  sourceBranch: string,
  events: DesktopUpdateCenterState[],
  commands: readonly string[] = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-center-test-" });
  const build = buildInfo(sourceBranch);
  yield* fs.writeFileString(
    `${root}/package.json`,
    yield* encodePackageInfo({ t3codeBuildInfo: build }),
  );
  const environment = DesktopEnvironment.layer({
    dirname: root,
    homeDirectory: root,
    platform: "win32",
    processArch: "x64",
    appVersion: build.artifactVersion,
    appPath: root,
    isPackaged: true,
    resourcesPath: root,
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: root })));
  const windows = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window create"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.die("unexpected reveal"),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        events.push(state as DesktopUpdateCenterState);
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
  return yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopAppSettings.layerTest(),
        windows,
        ElectronApp.layer,
        Layer.succeed(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          pickFiles: () => Effect.succeed(commands),
        }),
        DesktopAssets.layer,
      ).pipe(Layer.provideMerge(environment)),
    ),
  );
});

it.effect(
  "checks the installed branch, respects the global switch and polls only while enabled",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      using _fetch = vi.spyOn(Electron.net, "fetch").mockImplementation(async (url) => {
        requests.push(String(url));
        return Response.json(
          String(url).includes("releases/latest")
            ? {
                tag_name: "v0.1.8",
                html_url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.8",
                body: "## Changes\n- Display actual update notes\n- Preserve request limits",
                published_at: "2026-11-10T00:00:00Z",
              }
            : {
                commit: githubCommit("a".repeat(40), "feat: portable migrations\n\nKeep backups."),
              },
        );
      });
      const events: DesktopUpdateCenterState[] = [];
      const center = yield* fixture("main", events);
      yield* center.check;
      assert.lengthOf(requests, 2);
      assert.include(requests[1]!, "/branches/main");
      assert.isFalse((yield* center.getState).localAllowed);
      assert.equal((yield* center.getState).upstream.status, "available");
      assert.include(
        (yield* center.getState).upstream.releaseNotes?.items ?? [],
        "Display actual update notes",
      );
      assert.equal(
        (yield* center.getState).repository.commits?.[0]?.message,
        "feat: portable migrations\n\nKeep backups.",
      );
      assert.isTrue(
        (yield* Effect.result(center.configure({ quickUpdateEnabled: true })))._tag === "Failure",
      );
      yield* center.configure({ checkingEnabled: false });
      yield* center.check;
      yield* TestClock.adjust("31 minutes");
      assert.lengthOf(requests, 2);
      yield* center.configure({ checkingEnabled: true });
      yield* center.check;
      assert.lengthOf(requests, 4);
      yield* center.configure({ checkingEnabled: false });
      assert.isFalse(events.at(-1)!.preferences.checkingEnabled);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("shows the update range's commit messages with an explicit total when truncated", () =>
  Effect.gen(function* () {
    const commits = Array.from({ length: 15 }, (_, index) =>
      githubCommit(
        (index + 1).toString(16).padStart(40, "0"),
        `Change ${index + 1}\n\nCommit body ${index + 1}`,
      ),
    );
    using _fetch = vi.spyOn(Electron.net, "fetch").mockImplementation(async (url) =>
      Response.json(
        String(url).includes("releases/latest")
          ? {
              tag_name: "v0.1.8",
              html_url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.8",
              body: null,
              published_at: null,
            }
          : String(url).includes("/compare/")
            ? { status: "ahead", ahead_by: 15, behind_by: 0, commits }
            : { commit: commits.at(-1) },
      ),
    );
    const center = yield* fixture("develop", []);
    yield* center.check;
    const source = (yield* center.getState).repository;
    assert.equal(source.status, "available");
    assert.equal(source.commitCount, 15);
    assert.lengthOf(source.commits ?? [], 12);
    assert.equal(source.commits?.[0]?.message, "Change 15\n\nCommit body 15");
    assert.equal(source.commits?.[0]?.url, commits[14]!.html_url);
    assert.equal(source.commits?.at(-1)?.sha, commits[3]!.sha);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect(
  "keeps quick update disabled on picker cancellation and reports a missing CMD without exiting",
  () =>
    Effect.gen(function* () {
      const events: DesktopUpdateCenterState[] = [];
      const canceled = yield* fixture("develop", events);
      assert.isFalse(
        (yield* canceled.configure({ quickUpdateEnabled: true })).preferences.quickUpdateEnabled,
      );
      const center = yield* fixture("develop", events, ["Z:\\missing\\Migrate-T3-Code-Plus.cmd"]);
      yield* center.configure({ checkingEnabled: false });
      assert.isTrue(
        (yield* center.configure({ quickUpdateEnabled: true })).preferences.quickUpdateEnabled,
      );
      assert.isTrue((yield* Effect.result(center.install))._tag === "Failure");
      assert.isFalse((yield* center.getState).installing);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("coalesces concurrent checks and cancels network work when disabled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const pending = Promise.withResolvers<Response>();
    let calls = 0;
    let aborts = 0;
    using _fetch = vi.spyOn(Electron.net, "fetch").mockImplementation((_url, options) => {
      calls += 1;
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborts += 1;
        },
        { once: true },
      );
      if (calls === 2) Deferred.doneUnsafe(started, Effect.void);
      return pending.promise;
    });
    const center = yield* fixture("develop", []);
    const first = yield* Effect.forkScoped(center.check);
    yield* Deferred.await(started);
    const second = yield* Effect.forkScoped(center.check, { startImmediately: true });
    assert.equal(calls, 2);
    yield* center.configure({ checkingEnabled: false });
    yield* Fiber.await(first);
    yield* Fiber.await(second);
    assert.equal(aborts, 2);
    const state = yield* center.getState;
    assert.equal(state.upstream.status, "idle");
    assert.equal(state.repository.status, "idle");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("reports HTTP errors and honors GitHub rate-limit backoff", () =>
  Effect.gen(function* () {
    using fetch = vi
      .spyOn(Electron.net, "fetch")
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    const center = yield* fixture("main", []);
    yield* center.check;
    assert.equal((yield* center.getState).upstream.status, "error");
    const calls = fetch.mock.calls.length;
    yield* center.check;
    assert.equal(fetch.mock.calls.length, calls);
    assert.equal((yield* center.getState).repository.status, "error");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("a manual refresh joining a local poll still checks the remote sources", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-poll-" });
    const command = `${directory}/Migrate-T3-Code-Plus.cmd`;
    const manifestPath = `${directory}/release.json`;
    const target = { ...buildInfo("develop"), artifactVersion: "0.1.7-plus.20261109.4" };
    const encoded = yield* encodeManifest({
      appName: "T3 Code Plus",
      version: target.artifactVersion,
      buildInfo: target,
    });
    yield* fs.writeFileString(command, "@echo off");
    yield* fs.writeFileString(manifestPath, encoded);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    using fetch = vi.spyOn(Electron.net, "fetch").mockImplementation(async (url) =>
      Response.json(
        String(url).includes("releases/latest")
          ? {
              tag_name: "v0.1.7",
              html_url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.7",
              body: null,
              published_at: null,
            }
          : { commit: githubCommit("a".repeat(40), "Build portable migrations") },
      ),
    );
    const center = yield* fixture("develop", [], [command]).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (filename, encoding) =>
          filename.replaceAll("\\", "/") === manifestPath.replaceAll("\\", "/")
            ? Effect.gen(function* () {
                reads += 1;
                if (reads === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return encoded;
              })
            : fs.readFileString(filename, encoding),
      }),
    );
    yield* center.check;
    yield* center.configure({ quickUpdateEnabled: true });
    yield* Deferred.await(started);
    const manual = yield* Effect.forkScoped(center.check, { startImmediately: true });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(manual);
    assert.lengthOf(fetch.mock.calls, 4);
    assert.equal((yield* center.getState).local.status, "available");
    yield* center.configure({ checkingEnabled: false });
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
