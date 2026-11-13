import {
  DesktopBuildInfo,
  DesktopLocalPackageInfo,
  isReleaseBuild,
  LOCAL_PACKAGE_INFO_FILE,
  LOCAL_UPDATE_REFRESH_FILE,
  type DesktopUpdateCenterChange,
  type DesktopUpdateCenterState,
  type DesktopUpdateSource,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Electron from "electron";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { LocalUpdateRequest, startLocalUpdateCoordinator } from "../electron/WindowsLocalUpdate.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../ipc/channels.ts";
import {
  branchFeedCommits,
  compareBranchCommits,
  compareLocalSource,
  compareRelease,
  compareUpstream,
  releaseFeedEntry,
  releaseManifestVersion,
  supportsLocalUpdate,
  updateSource,
} from "./updateCenterSources.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";

export class UpdateCenterError extends Schema.TaggedError<UpdateCenterError>()(
  "UpdateCenterError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
const fail = (detail: string) => Effect.fail(new UpdateCenterError({ detail }));
const PackageInfo = Schema.Struct({ t3codeBuildInfo: DesktopBuildInfo });
const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const REMOTE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LOCAL_CHECK_INTERVAL = "10 minutes";
const LOCAL_WATCH_FILES = new Set([LOCAL_PACKAGE_INFO_FILE, LOCAL_UPDATE_REFRESH_FILE]);
const decodeApiRelease = Schema.decodeUnknownEffect(
  Schema.Struct({ body: Schema.NullOr(Schema.String), published_at: Schema.NullOr(Schema.String) }),
);
const decodeLocalPackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopLocalPackageInfo),
);
const isRevision = (value: string | null): value is string =>
  value !== null && /^[a-f0-9]{40}$/i.test(value);
const encodeLocalUpdateRequest = Schema.encodeEffect(Schema.fromJsonString(LocalUpdateRequest));
const isUpdateCenterError = Schema.is(UpdateCenterError);
const asUpdateError = (error: unknown) =>
  isUpdateCenterError(error)
    ? error
    : new UpdateCenterError({ detail: error instanceof Error ? error.message : String(error) });

export class DesktopUpdateCenter extends Context.Service<
  DesktopUpdateCenter,
  {
    readonly start: Effect.Effect<void>;
    readonly getState: Effect.Effect<DesktopUpdateCenterState>;
    readonly configure: (
      change: DesktopUpdateCenterChange,
    ) => Effect.Effect<DesktopUpdateCenterState, UpdateCenterError>;
    readonly chooseSource: Effect.Effect<DesktopUpdateCenterState, UpdateCenterError>;
    readonly check: Effect.Effect<DesktopUpdateCenterState>;
    readonly install: Effect.Effect<boolean, UpdateCenterError>;
  }
>()("@t3tools/desktop/updates/DesktopUpdateCenter") {}

/** Owns checks in the desktop scope; no timers or executable paths come from a remote environment. */
export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const windows = yield* ElectronWindow.ElectronWindow;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const app = yield* ElectronApp.ElectronApp;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const assets = yield* DesktopAssets.DesktopAssets;
  const executable = yield* HostProcess.ExecutablePath;
  const path = environment.path;
  const parsed = yield* fs
    .readFileString(path.join(environment.appPath, "package.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PackageInfo))),
      Effect.option,
    );
  const build: DesktopBuildInfo = Option.isSome(parsed)
    ? parsed.value.t3codeBuildInfo
    : {
        artifactVersion: environment.appVersion,
        upstreamVersion: null,
        repository: "",
        sourceBranch: null,
        sourceRevision: null,
        sourceDirty: false,
        builtAt: null,
        platform: environment.platform,
        arch: environment.processArch,
      };
  const stateRef = yield* Ref.make<DesktopUpdateCenterState>({
    supported: environment.platform === "win32",
    localAllowed: supportsLocalUpdate(build, environment.isPackaged),
    preferences: (yield* settings.get).updateCenter,
    build,
    upstream: updateSource(build.upstreamVersion),
    repository: updateSource(build.sourceRevision),
    release: updateSource(build.artifactVersion),
    local: updateSource(build.artifactVersion),
    installing: false,
  });
  const publish = Effect.fn("desktop.updateCenter.publish")(function* (
    change: Partial<DesktopUpdateCenterState>,
  ) {
    const next = yield* Ref.updateAndGet(stateRef, (state) => ({ ...state, ...change }));
    yield* windows.sendAll(IpcChannels.UPDATE_CENTER_STATE_CHANNEL, next);
    return next;
  });
  const timerRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
  const checkRef = yield* Ref.make<{
    readonly fiber: Fiber.Fiber<DesktopUpdateCenterState>;
    readonly remote: boolean;
  } | null>(null);
  const checkGate = yield* Semaphore.make(1);
  const actionGate = yield* Semaphore.make(1);
  const watcherRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
  const lastRemote = yield* Ref.make(-REMOTE_CHECK_INTERVAL_MS);

  // Public github.com pages, the ones the built-in updater reads, avoid the REST API's 60
  // requests per hour per IP, which a shared office network can exhaust on its own.
  const github = Effect.fn("desktop.updateCenter.github")(function* (page: string) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await Electron.net.fetch(`https://github.com/${page}`, { signal });
        if (response.status === 404) return null;
        if (!response.ok)
          throw new UpdateCenterError({
            detail:
              response.status === 429
                ? "GitHub 暂时限制了访问，请稍后再检查。"
                : `GitHub 请求失败 (${response.status})，请检查网络、仓库或分支是否存在。`,
          });
        return await response.text();
      },
      catch: asUpdateError,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => fail("GitHub 请求超时，请检查网络与代理。"),
      }),
    );
  });

  const releaseNotesFromApi = Effect.fn("desktop.updateCenter.releaseNotesFromApi")(function* (
    repository: string,
    tag: string,
  ) {
    const release = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await Electron.net.fetch(
          `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
          { signal, headers: { Accept: "application/vnd.github+json" } },
        );
        if (!response.ok) throw new Error(`GitHub API ${response.status}`);
        return (await response.json()) as unknown;
      },
      catch: asUpdateError,
    }).pipe(
      Effect.flatMap(decodeApiRelease),
      Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => fail("GitHub API 超时。") }),
    );
    return release.body ? { notesHtml: release.body, updated: release.published_at } : null;
  });

  /** The latest non-prerelease release, from the `latest.yml` the updater also installs from. */
  const latestRelease = Effect.fn("desktop.updateCenter.latestRelease")(function* (
    repository: string,
  ) {
    const manifest = yield* github(`${repository}/releases/latest/download/latest.yml`);
    if (manifest === null) return null;
    const version = releaseManifestVersion(manifest);
    if (!version) return yield* fail("发布的 latest.yml 里没有版本号。");
    const tag = `v${version}`;
    // Notes are optional: the feed only lists recent releases.
    const feed = yield* github(`${repository}/releases.atom`).pipe(
      Effect.orElseSucceed(() => null),
    );
    // Frequent prereleases can push a stable release out of the feed. Only then is the rate-limited
    // REST API asked, and a refusal just leaves the notes out.
    const entry =
      (feed === null ? null : releaseFeedEntry(feed, tag)) ??
      (yield* releaseNotesFromApi(repository, tag).pipe(Effect.orElseSucceed(() => null)));
    const notes = entry
      ? normalizeDesktopUpdateReleaseNotes(
          entry.notesHtml,
          version,
          "latest",
          entry.updated ?? undefined,
        ).releaseNotes[0]
      : undefined;
    return {
      version,
      url: `https://github.com/${repository}/releases/tag/${tag}`,
      ...(notes ? { releaseNotes: notes } : {}),
    };
  });

  const git = (source: string, args: readonly string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", ["-C", source, ...args], {
            stdin: "ignore",
            stderr: "ignore",
            forceKillAfter: "1 second",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? Option.some(stdout.trim()) : Option.none<string>();
      }),
    ).pipe(
      Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.succeedNone }),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  const commitsSince = (source: string, revision: string | null) =>
    isRevision(revision)
      ? git(source, ["rev-list", "--count", `${revision}..HEAD`]).pipe(
          Effect.map((count) =>
            Option.isSome(count) && /^\d+$/.test(count.value) ? Number(count.value) : null,
          ),
        )
      : Effect.succeed(null);

  const readLocal = Effect.fn("desktop.updateCenter.readLocal")(function* () {
    const state = yield* Ref.get(stateRef);
    const source = state.preferences.sourcePath;
    if (!state.localAllowed || !state.preferences.quickUpdateEnabled || !source)
      return yield* fail("请在设置中启用快捷本地更新并选择源码仓库。");
    if (Option.isNone(yield* git(source, ["rev-parse", "--is-inside-work-tree"])))
      return yield* fail("所选目录不是 Git 源码仓库，请在设置中重新选择。");
    const releaseDirectory = path.join(source, "release");
    const infoPath = path.join(releaseDirectory, LOCAL_PACKAGE_INFO_FILE);
    const local = (yield* fs.exists(infoPath))
      ? yield* fs.readFileString(infoPath).pipe(
          Effect.flatMap(decodeLocalPackage),
          Effect.mapError(
            () =>
              new UpdateCenterError({
                detail: `${LOCAL_PACKAGE_INFO_FILE} 无效，请运行 vp run dist:desktop:win 重新打包。`,
              }),
          ),
        )
      : null;
    const installer = local ? path.join(releaseDirectory, local.installer) : null;
    if (
      local &&
      installer &&
      (path.basename(local.installer) !== local.installer || !(yield* fs.exists(installer)))
    )
      return yield* fail(`安装包 ${local.installer} 不存在，请重新打包。`);
    const [status, commitsSinceInstalled, commitsSincePackage] = yield* Effect.all(
      [
        git(source, ["status", "--porcelain"]),
        commitsSince(source, build.sourceRevision),
        commitsSince(source, local?.buildInfo.sourceRevision ?? null),
      ],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(status)) return yield* fail("无法读取源码仓库的 Git 状态。");
    const update = compareLocalSource(build, local, {
      dirty: status.value.length > 0,
      commitsSinceInstalled,
      commitsSincePackage,
    });
    return { update, local, installer };
  });

  const checkSources = Effect.fn("desktop.updateCenter.checkSources")(function* (
    checkRemote: boolean,
  ) {
    const state = yield* Ref.get(stateRef);
    if (!state.supported || !state.preferences.checkingEnabled || state.installing) return state;
    const now = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const runSource = Effect.fn("desktop.updateCenter.runSource")(function* <E, R>(
      key: "upstream" | "repository" | "release" | "local",
      task: Effect.Effect<DesktopUpdateSource, E, R>,
    ) {
      yield* publish({ [key]: { ...state[key], status: "checking", message: null } });
      const result = yield* task.pipe(
        Effect.catch((error) =>
          Effect.succeed<DesktopUpdateSource>({
            ...state[key],
            status: "error",
            message: error instanceof Error ? error.message : String(error),
            checkedAt,
          }),
        ),
      );
      yield* Effect.annotateCurrentSpan({
        source: key,
        status: result.status,
        current: result.current,
        latest: result.latest,
        majorUpdate: result.majorUpdate,
      });
      yield* publish({ [key]: { ...result, checkedAt } });
    });
    const tasks = [];
    if (checkRemote) yield* Ref.set(lastRemote, now);
    // Release builds follow published releases; development builds follow source.
    if (checkRemote && isReleaseBuild(build)) {
      tasks.push(
        runSource(
          "release",
          Effect.gen(function* () {
            if (!GITHUB_REPOSITORY.test(build.repository))
              return {
                ...state.release,
                status: "unsupported" as const,
                message: "当前包未记录发布仓库，请安装新版 Plus 包。",
              };
            const release = yield* latestRelease(build.repository);
            if (release === null)
              return {
                ...state.release,
                status: "unsupported" as const,
                message: `${build.repository} 还没有发布 Release。`,
              };
            const { version, ...details } = release;
            return { ...compareRelease(build, version), ...details };
          }),
        ),
      );
    }
    if (checkRemote && !isReleaseBuild(build)) {
      tasks.push(
        runSource(
          "upstream",
          Effect.gen(function* () {
            if (!build.upstreamVersion)
              return {
                ...state.upstream,
                status: "unsupported" as const,
                message: "当前包未记录上游版本，请安装新版 Plus 包。",
              };
            const release = yield* latestRelease("pingdotgg/t3code");
            if (release === null) return yield* fail("没有找到上游 T3 Code 的最新发布。");
            const { version, ...details } = release;
            return { ...compareUpstream(build, version), ...details };
          }),
        ),
      );
      tasks.push(
        runSource(
          "repository",
          Effect.gen(function* () {
            if (
              !GITHUB_REPOSITORY.test(build.repository) ||
              !build.sourceBranch ||
              !build.sourceRevision
            )
              return {
                ...state.repository,
                status: "unsupported" as const,
                message: "当前包缺少仓库、分支或提交信息，请安装新版 Plus 包。",
              };
            const feed = yield* github(
              `${build.repository}/commits/${encodeURIComponent(build.sourceBranch)}.atom`,
            );
            if (feed === null) return yield* fail(`远端没有 ${build.sourceBranch} 分支。`);
            const result = compareBranchCommits(build, branchFeedCommits(feed));
            return {
              ...result,
              url:
                result.latest && result.latest !== build.sourceRevision
                  ? `https://github.com/${build.repository}/compare/${build.sourceRevision}...${result.latest}`
                  : `https://github.com/${build.repository}/commit/${build.sourceRevision}`,
            };
          }),
        ),
      );
    }
    if (state.localAllowed && state.preferences.quickUpdateEnabled)
      tasks.push(runSource("local", readLocal().pipe(Effect.map(({ update }) => update))));
    yield* Effect.all(tasks, { concurrency: "unbounded", discard: true });
    return yield* Ref.get(stateRef);
  });

  const check = Effect.fn("desktop.updateCenter.check")(function* (
    remote: boolean,
  ): Effect.fn.Return<DesktopUpdateCenterState> {
    const active = yield* checkGate.withPermits(1)(
      Effect.gen(function* () {
        const running = yield* Ref.get(checkRef);
        if (running) return running;
        const includesRemote =
          remote ||
          (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastRemote)) >=
            REMOTE_CHECK_INTERVAL_MS;
        const fiber = yield* Effect.forkIn(
          checkSources(includesRemote).pipe(Effect.ensuring(Ref.set(checkRef, null))),
          scope,
          { startImmediately: false },
        );
        const next = { fiber, remote: includesRemote };
        yield* Ref.set(checkRef, next);
        return next;
      }),
    );
    const state = yield* Fiber.join(active.fiber);
    // A manual click joining the minute-only local check must still refresh both remote sources.
    if (remote && !active.remote && state.preferences.checkingEnabled && !state.installing)
      return yield* check(true);
    return state;
  });
  const stop = Effect.gen(function* () {
    const timer = yield* Ref.getAndSet(timerRef, null);
    if (timer) yield* Fiber.interrupt(timer);
    const watcher = yield* Ref.getAndSet(watcherRef, null);
    if (watcher) yield* Fiber.interrupt(watcher);
    const running = yield* Ref.getAndSet(checkRef, null);
    if (running) yield* Fiber.interrupt(running.fiber);
    const state = yield* Ref.get(stateRef);
    yield* publish(
      Object.fromEntries(
        (["upstream", "repository", "release", "local"] as const)
          .filter((key) => state[key].status === "checking")
          .map((key) => [key, { ...state[key], status: "idle", message: "检查已取消。" }]),
      ),
    );
  });
  const restart = Effect.gen(function* () {
    yield* stop;
    const state = yield* Ref.get(stateRef);
    if (!state.supported || !state.preferences.checkingEnabled) return;
    const timer = yield* Effect.forkIn(
      check(false).pipe(
        Effect.asVoid,
        Effect.repeat(Schedule.spaced(LOCAL_CHECK_INTERVAL)),
        Effect.asVoid,
      ),
      scope,
    );
    yield* Ref.set(timerRef, timer);
    const source = state.preferences.sourcePath;
    if (!state.localAllowed || !state.preferences.quickUpdateEnabled || !source) return;
    // A finished build or a refresh request updates the entry at once instead of on the next poll.
    // The folder is gitignored; creating it lets a fresh clone's first build be noticed too.
    const releaseDirectory = path.join(source, "release");
    yield* fs.makeDirectory(releaseDirectory, { recursive: true }).pipe(Effect.ignore);
    // Git appends to logs/HEAD on every commit, checkout, merge and reset, but not on status.
    const gitDirectory = yield* git(source, ["rev-parse", "--absolute-git-dir"]);
    const headLog = Option.isSome(gitDirectory)
      ? fs.watch(path.join(gitDirectory.value, "logs")).pipe(
          Stream.filter((event) => path.basename(event.path) === "HEAD"),
          Stream.ignore,
        )
      : Stream.empty;
    const watcher = yield* Effect.forkIn(
      fs.watch(releaseDirectory).pipe(
        Stream.filter((event) => LOCAL_WATCH_FILES.has(path.basename(event.path))),
        // Each watch ends on its own error, such as a missing folder, without stopping the other.
        Stream.ignore,
        Stream.merge(headLog),
        Stream.debounce("2 seconds"),
        Stream.runForEach(() => check(false)),
        Effect.ignore,
      ),
      scope,
    );
    yield* Ref.set(watcherRef, watcher);
  });

  const chooseSource = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (!state.localAllowed) return yield* fail("快捷本地更新仅限 Windows 安装包。");
    const picked = yield* dialog.pickFolder({
      owner: yield* windows.focusedMainOrFirst,
      defaultPath: Option.fromNullishOr(state.preferences.sourcePath),
    });
    if (Option.isNone(picked)) return state;
    const root = yield* git(picked.value, ["rev-parse", "--show-toplevel"]);
    if (Option.isNone(root)) return yield* fail("所选目录不是 Git 源码仓库。");
    const preferences = {
      ...state.preferences,
      sourcePath: path.normalize(root.value),
      quickUpdateEnabled: true,
    };
    yield* settings.setUpdateCenter(preferences);
    yield* publish({ preferences });
    yield* restart;
    return yield* Ref.get(stateRef);
  });

  const install = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (
      !state.supported ||
      !state.preferences.checkingEnabled ||
      !state.localAllowed ||
      !state.preferences.quickUpdateEnabled
    )
      return yield* fail("当前客户端未开启快捷本地更新。");
    const { update, local, installer } = yield* readLocal();
    if (update.status !== "available" || !local || !installer)
      return yield* fail(update.message ?? "没有可安装的更新版本。");
    // NSIS installs into the directory that holds the running executable.
    const installDirectory = path.dirname(executable);
    const scriptSource = yield* assets.resolveResourcePath("local-update.ps1");
    if (Option.isNone(scriptSource))
      return yield* fail("当前包缺少本地更新程序 local-update.ps1，请手动运行一次安装包。");
    yield* publish({ installing: true });
    const handoff = Effect.gen(function* () {
      const owner = Option.getOrUndefined(yield* windows.focusedMainOrFirst);
      const answer = yield* dialog.showMessageBox(
        {
          type: "question",
          title: "更新 T3 Code Plus",
          message: `退出并更新到 ${local.version}？`,
          detail: `当前版本：${build.artifactVersion}\n安装目录：${installDirectory}\n安装包：${installer}\n\n客户端和本机托管的运行任务将正常退出，独立窗口显示安装进度，完成后自动打开新客户端。`,
          buttons: ["取消", "退出并更新"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        },
        owner,
      );
      if (answer.response !== 1) return false;
      // The coordinator outlives this installation, so it runs from a temporary copy.
      const temporary = yield* fs.makeTempDirectory({ prefix: "t3code-local-update-" });
      const script = path.join(temporary, "local-update.ps1");
      const requestPath = path.join(temporary, "request.json");
      // Windows PowerShell 5 reads a UTF-8 script correctly only with a BOM.
      yield* fs.writeFileString(
        script,
        `﻿${(yield* fs.readFileString(scriptSource.value)).replace(/^﻿/, "")}`,
      );
      yield* fs.writeFileString(
        requestPath,
        yield* encodeLocalUpdateRequest({
          installer,
          installDirectory,
          executable,
          targetVersion: local.version,
        }),
      );
      yield* stop;
      yield* startLocalUpdateCoordinator({ script, requestPath }).pipe(
        Effect.tapError(() => restart),
      );
      yield* app.quit;
      return true;
    });
    return yield* handoff.pipe(Effect.ensuring(publish({ installing: false }).pipe(Effect.asVoid)));
  });

  return DesktopUpdateCenter.of({
    start: Effect.gen(function* () {
      yield* publish({ preferences: (yield* settings.get).updateCenter });
      yield* restart;
    }),
    getState: Ref.get(stateRef),
    check: check(true),
    chooseSource: actionGate.withPermits(1)(chooseSource).pipe(Effect.mapError(asUpdateError)),
    configure: Effect.fn("desktop.updateCenter.configure")(function (change) {
      return actionGate
        .withPermits(1)(
          Effect.gen(function* () {
            const state = yield* Ref.get(stateRef);
            if (change.quickUpdateEnabled && !state.localAllowed)
              return yield* fail("快捷本地更新仅限 Windows 安装包。");
            if (
              change.quickUpdateEnabled &&
              (!state.preferences.sourcePath || !(yield* fs.exists(state.preferences.sourcePath)))
            )
              return yield* chooseSource;
            const preferences = {
              ...state.preferences,
              checkingEnabled: change.checkingEnabled ?? state.preferences.checkingEnabled,
              quickUpdateEnabled: change.quickUpdateEnabled ?? state.preferences.quickUpdateEnabled,
            };
            yield* settings.setUpdateCenter(preferences);
            yield* publish({ preferences });
            yield* restart;
            return yield* Ref.get(stateRef);
          }),
        )
        .pipe(Effect.mapError(asUpdateError));
    }),
    install: actionGate.withPermits(1)(install).pipe(Effect.mapError(asUpdateError)),
  });
});
export const layer = Layer.effect(DesktopUpdateCenter, make);
