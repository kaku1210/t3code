import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import {
  DesktopBuildInfo,
  DesktopLocalPackageInfo,
  LOCAL_PACKAGE_INFO_FILE,
  type DesktopUpdateCenterState,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { make } from "./DesktopUpdateCenter.ts";

vi.mock("electron", () => ({ net: { fetch: vi.fn() }, app: {} }));
const encodePackageInfo = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ t3codeBuildInfo: DesktopBuildInfo })),
);
const encodeLocalPackage = Schema.encodeEffect(Schema.fromJsonString(DesktopLocalPackageInfo));
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
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const feed = (...entries: string[]) => `<?xml version="1.0"?><feed>${entries.join("")}</feed>`;
const releaseEntry = (repository: string, tag: string, html: string) =>
  `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-11-10T00:00:00Z</updated>` +
  `<link rel="alternate" type="text/html" href="https://github.com/${repository}/releases/tag/${tag}"/>` +
  `<title>${tag}</title><content type="html">${escapeXml(html)}</content></entry>`;
// GitHub escapes the message as HTML inside <pre>, then escapes that HTML for the feed.
const commitEntry = (sha: string, message: string) =>
  `<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id>` +
  `<link type="text/html" rel="alternate" href="https://github.com/kaku1210/t3code/commit/${sha}"/>` +
  `<title>${escapeXml(message.split("\n")[0]!)}</title><content type="html">` +
  escapeXml(`<pre style='white-space:pre-wrap;width:81ex'>${escapeXml(message)}</pre>`) +
  `</content></entry>`;
/** Serves github.com pages by path suffix; anything else is a 404. */
const githubPages = (pages: Record<string, string>, requests: string[] = []) =>
  vi.spyOn(Electron.net, "fetch").mockImplementation(async (url) => {
    requests.push(String(url));
    const page = Object.entries(pages).find(([suffix]) => String(url).endsWith(suffix));
    return page ? new Response(page[1]) : new Response(null, { status: 404 });
  });

const fixture = Effect.fn("updateCenterTest.fixture")(function* (
  sourceBranch: string,
  events: DesktopUpdateCenterState[],
  folder: string | null = null,
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
          pickFolder: () => Effect.succeed(Option.fromNullishOr(folder)),
        }),
        DesktopAssets.layer,
      ).pipe(Layer.provideMerge(environment)),
    ),
  );
});

it.effect(
  "checks published releases for main builds and source for development builds, only while enabled",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      using _fetch = githubPages(
        {
          "kaku1210/t3code/releases/latest/download/latest.yml":
            "version: 0.1.7-plus.20261110.1\nfiles: []\n",
          "kaku1210/t3code/releases.atom": feed(
            releaseEntry(
              "kaku1210/t3code",
              "v0.1.7-plus.20261110.1",
              "<ul><li>Ship the Plus installer</li></ul>",
            ),
          ),
          "pingdotgg/t3code/releases/latest/download/latest.yml": "version: '0.1.8'\n",
          "pingdotgg/t3code/releases.atom": feed(
            releaseEntry("pingdotgg/t3code", "v0.1.9-nightly.20261111.1", "<p>Nightly</p>"),
            releaseEntry(
              "pingdotgg/t3code",
              "v0.1.8",
              "<h2>Changes</h2><ul><li>Display actual update notes</li><li>Preserve request limits</li></ul>",
            ),
          ),
          "kaku1210/t3code/commits/develop.atom": feed(
            commitEntry("a".repeat(40), "feat: portable migrations\n\nKeep <backups> & logs."),
          ),
        },
        requests,
      );
      const releaseBuild = yield* fixture("main", []);
      yield* releaseBuild.check;
      const published = yield* releaseBuild.getState;
      assert.equal(published.release.status, "available");
      assert.equal(published.release.latest, "0.1.7-plus.20261110.1");
      assert.include(published.release.releaseNotes?.items ?? [], "Ship the Plus installer");
      assert.isFalse(published.localAllowed);
      assert.equal(published.upstream.status, "idle");
      assert.equal(published.repository.status, "idle");
      assert.isTrue(requests.every((url) => url.startsWith("https://github.com/kaku1210/")));

      requests.length = 0;
      const events: DesktopUpdateCenterState[] = [];
      const center = yield* fixture("develop", events);
      yield* center.check;
      assert.lengthOf(requests, 3);
      assert.isTrue(requests.every((url) => url.startsWith("https://github.com/")));
      assert.equal((yield* center.getState).release.status, "idle");
      assert.isTrue((yield* center.getState).localAllowed);
      assert.equal((yield* center.getState).upstream.status, "available");
      assert.include(
        (yield* center.getState).upstream.releaseNotes?.items ?? [],
        "Display actual update notes",
      );
      assert.equal(
        (yield* center.getState).repository.commits?.[0]?.message,
        "feat: portable migrations\n\nKeep <backups> & logs.",
      );
      assert.equal((yield* center.getState).repository.status, "current");
      yield* center.configure({ checkingEnabled: false });
      yield* center.check;
      yield* TestClock.adjust("31 minutes");
      assert.lengthOf(requests, 3);
      yield* center.configure({ checkingEnabled: true });
      yield* center.check;
      assert.lengthOf(requests, 6);
      yield* center.configure({ checkingEnabled: false });
      assert.isFalse(events.at(-1)!.preferences.checkingEnabled);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("shows the update range's commit messages with an explicit total when truncated", () =>
  Effect.gen(function* () {
    const newer = Array.from({ length: 15 }, (_, index) => ({
      sha: (index + 1).toString(16).padStart(40, "0"),
      message: `Change ${index + 1}\n\nCommit body ${index + 1}`,
    })).reverse();
    using _fetch = githubPages({
      "kaku1210/t3code/commits/develop.atom": feed(
        ...newer.map((commit) => commitEntry(commit.sha, commit.message)),
        commitEntry("a".repeat(40), "The installed build"),
      ),
    });
    const center = yield* fixture("develop", []);
    yield* center.check;
    const source = (yield* center.getState).repository;
    assert.equal(source.status, "available");
    assert.equal(source.commitCount, 15);
    assert.lengthOf(source.commits ?? [], 12);
    assert.equal(source.commits?.[0]?.message, "Change 15\n\nCommit body 15");
    assert.equal(
      source.commits?.[0]?.url,
      `https://github.com/kaku1210/t3code/commit/${newer[0]!.sha}`,
    );
    assert.equal(source.commits?.at(-1)?.sha, newer[11]!.sha);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect(
  "keeps quick update disabled on picker cancellation and rejects a folder outside Git",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events: DesktopUpdateCenterState[] = [];
      const canceled = yield* fixture("develop", events);
      assert.isFalse(
        (yield* canceled.configure({ quickUpdateEnabled: true })).preferences.quickUpdateEnabled,
      );
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-not-a-checkout-" });
      const center = yield* fixture("develop", events, folder);
      yield* center.configure({ checkingEnabled: false });
      assert.isTrue(
        (yield* Effect.result(center.configure({ quickUpdateEnabled: true })))._tag === "Failure",
      );
      assert.isFalse((yield* center.getState).preferences.quickUpdateEnabled);
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

it.effect("reports a GitHub refusal on each remote source", () =>
  Effect.gen(function* () {
    using _fetch = vi
      .spyOn(Electron.net, "fetch")
      .mockResolvedValue(new Response(null, { status: 429 }));
    const releaseBuild = yield* fixture("main", []);
    yield* releaseBuild.check;
    const developmentBuild = yield* fixture("develop", []);
    yield* developmentBuild.check;
    const development = yield* developmentBuild.getState;
    for (const source of [
      (yield* releaseBuild.getState).release,
      development.upstream,
      development.repository,
    ]) {
      assert.equal(source.status, "error");
      assert.include(source.message ?? "", "GitHub");
    }
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("falls back to the release API for notes the feed no longer lists", () =>
  Effect.gen(function* () {
    using _fetch = githubPages({
      "pingdotgg/t3code/releases/latest/download/latest.yml": "version: 0.1.8\n",
      "pingdotgg/t3code/releases.atom": feed(
        releaseEntry("pingdotgg/t3code", "v0.1.9-nightly.20261111.1", "<p>Nightly</p>"),
      ),
      "repos/pingdotgg/t3code/releases/tags/v0.1.8": JSON.stringify({
        body: "- Notes from the API",
        published_at: "2026-11-10T00:00:00Z",
      }),
    });
    const center = yield* fixture("develop", []);
    yield* center.check;
    assert.include(
      (yield* center.getState).upstream.releaseNotes?.items ?? [],
      "Notes from the API",
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("reports a repository without releases instead of failing", () =>
  Effect.gen(function* () {
    using _fetch = githubPages({});
    const center = yield* fixture("main", []);
    yield* center.check;
    const release = (yield* center.getState).release;
    assert.equal(release.status, "unsupported");
    assert.include(release.message ?? "", "还没有发布 Release");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("a manual refresh joining a local poll still checks the remote sources", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-poll-" });
    yield* (yield* spawner.spawn(ChildProcess.make("git", ["init", "-q", directory]))).exitCode;
    const manifestPath = `${directory}/release/${LOCAL_PACKAGE_INFO_FILE}`;
    const target = { ...buildInfo("develop"), artifactVersion: "0.1.7-plus.20261109.4" };
    const installer = `T3-Code-Plus-${target.artifactVersion}-x64.exe`;
    const encoded = yield* encodeLocalPackage({
      version: target.artifactVersion,
      installer,
      buildInfo: target,
    });
    yield* fs.makeDirectory(`${directory}/release`);
    yield* fs.writeFileString(`${directory}/release/${installer}`, "installer");
    yield* fs.writeFileString(manifestPath, encoded);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    using fetch = githubPages({
      "latest.yml": "version: 0.1.7\n",
      "kaku1210/t3code/commits/develop.atom": feed(
        commitEntry("a".repeat(40), "Build portable migrations"),
      ),
    });
    const center = yield* fixture("develop", [], directory).pipe(
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
    // Two remote checks, each reading the upstream release manifest.
    assert.lengthOf(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("latest.yml")),
      2,
    );
    assert.equal((yield* center.getState).local.status, "available");
    yield* center.configure({ checkingEnabled: false });
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live(
  "refreshes the local source as soon as a fresh clone's first build writes its package",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-watch-" });
      yield* (yield* spawner.spawn(ChildProcess.make("git", ["init", "-q", directory]))).exitCode;
      using _fetch = githubPages({});
      const available = yield* Deferred.make<void>();
      const events = {
        push: (state: DesktopUpdateCenterState) => {
          if (state.local.status === "available") Deferred.doneUnsafe(available, Effect.void);
          return 0;
        },
      } as unknown as DesktopUpdateCenterState[];
      const center = yield* fixture("develop", events, directory);
      yield* center.configure({ quickUpdateEnabled: true });
      // Settle the first check, so only the watcher can see the package; the next poll is 10 minutes out.
      yield* center.check;
      assert.notEqual((yield* center.getState).local.status, "available");

      const target = { ...buildInfo("develop"), artifactVersion: "0.1.7-plus.20261109.4" };
      const installer = `T3-Code-Plus-${target.artifactVersion}-x64.exe`;
      // The build creates the folder when missing, as electron-builder does.
      yield* fs.makeDirectory(`${directory}/release`, { recursive: true });
      yield* fs.writeFileString(`${directory}/release/${installer}`, "installer");
      yield* fs.writeFileString(
        `${directory}/release/${LOCAL_PACKAGE_INFO_FILE}`,
        yield* encodeLocalPackage({
          version: target.artifactVersion,
          installer,
          buildInfo: target,
        }),
      );
      yield* Deferred.await(available);
      yield* center.configure({ checkingEnabled: false });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("compares the checkout again as soon as a commit lands", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-commit-" });
    const commit = (message: string) =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "git",
            [
              "-c",
              "user.name=t",
              "-c",
              "user.email=t@t",
              "commit",
              "-q",
              "--allow-empty",
              "-m",
              message,
            ],
            { cwd: directory },
          ),
        );
        assert.equal(Number(yield* handle.exitCode), 0);
      });
    yield* (yield* spawner.spawn(ChildProcess.make("git", ["init", "-q", directory]))).exitCode;
    yield* commit("initial");
    using _fetch = githubPages({});
    let committed = false;
    const rechecked = yield* Deferred.make<void>();
    const events = {
      push: (state: DesktopUpdateCenterState) => {
        if (committed && state.local.status === "checking")
          Deferred.doneUnsafe(rechecked, Effect.void);
        return 0;
      },
    } as unknown as DesktopUpdateCenterState[];
    const center = yield* fixture("develop", events, directory);
    yield* center.configure({ quickUpdateEnabled: true });
    // Settle the first check; the next poll is 10 minutes out, so only the watcher can check again.
    yield* center.check;
    committed = true;
    yield* commit("second");
    yield* Deferred.await(rechecked);
    yield* center.configure({ checkingEnabled: false });
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
