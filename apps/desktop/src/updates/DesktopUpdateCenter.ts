import {
  DesktopBuildInfo,
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
import * as Electron from "electron";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { runWindowsLocalUpdate } from "../electron/WindowsLocalUpdate.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../ipc/channels.ts";
import {
  compareLocalPackage,
  compareUpstream,
  PortableUpdateManifest,
  repositoryUpdateStatus,
  supportsLocalUpdate,
  updateSource,
} from "./updateCenterSources.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";

export class UpdateCenterError extends Schema.TaggedError<UpdateCenterError>()(
  "UpdateCenterError",
  { detail: Schema.String, retryAt: Schema.optionalKey(Schema.Number) },
) {
  override get message() {
    return this.detail;
  }
}
const fail = (detail: string) => Effect.fail(new UpdateCenterError({ detail }));
const PackageInfo = Schema.Struct({ t3codeBuildInfo: DesktopBuildInfo });
const GithubRelease = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
  published_at: Schema.NullOr(Schema.String),
});
const GithubCommit = Schema.Struct({
  sha: Schema.String,
  html_url: Schema.String,
  commit: Schema.Struct({ message: Schema.String }),
});
const GithubBranch = Schema.Struct({ commit: GithubCommit });
const GithubComparison = Schema.Struct({
  status: Schema.String,
  ahead_by: Schema.Number,
  behind_by: Schema.Number,
  commits: Schema.Array(GithubCommit),
});
const updateCommit = (commit: typeof GithubCommit.Type) => ({
  sha: commit.sha,
  message: commit.commit.message,
  url: commit.html_url,
});
const MAX_UPDATE_COMMITS = 12;
const UpdateRequest = Schema.fromJsonString(
  Schema.Struct({
    commandPath: Schema.String,
    destinationRoot: Schema.String,
    executableName: Schema.String,
    targetVersion: Schema.String,
    sourceBranch: Schema.NullOr(Schema.String),
    parentPid: Schema.Number,
  }),
);
const isUpdateCenterError = Schema.is(UpdateCenterError);
const encodeUpdateRequest = Schema.encodeEffect(UpdateRequest);
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
    readonly chooseCommand: Effect.Effect<DesktopUpdateCenterState, UpdateCenterError>;
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
  const lastRemote = yield* Ref.make(-1800000);
  const retryAfter = yield* Ref.make(0);

  const json = Effect.fn("desktop.updateCenter.github")(function* (endpoint: string) {
    const now = yield* Clock.currentTimeMillis;
    if (now < (yield* Ref.get(retryAfter))) return yield* fail("GitHub 请求已限流，请在稍后重试。");
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await Electron.net.fetch(`https://api.github.com/repos/${endpoint}`, {
          signal,
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) {
          const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
          const wait = Number(response.headers.get("retry-after")) * 1000;
          if (response.status === 403 || response.status === 429) {
            // Rate-limit state is published by the request's Effect below.
            const retryAt = Math.max(
              Number.isFinite(reset) ? reset : 0,
              now + (Number.isFinite(wait) && wait > 0 ? wait : 1800000),
            );
            throw new UpdateCenterError({
              detail: `GitHub 限流 (${response.status})，请在 ${DateTime.formatIso(DateTime.makeUnsafe(retryAt))} 后重试。`,
              retryAt,
            });
          }
          throw new Error(`GitHub 请求失败 (${response.status})，请检查网络、仓库或分支是否存在。`);
        }
        return (await response.json()) as unknown;
      },
      catch: asUpdateError,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => fail("GitHub 请求超时，请检查网络与代理。"),
      }),
      Effect.tapError((error) => {
        return error.retryAt ? Ref.set(retryAfter, error.retryAt) : Effect.void;
      }),
    );
  });

  const readLocal = Effect.fn("desktop.updateCenter.readLocal")(function* () {
    const state = yield* Ref.get(stateRef);
    const command = state.preferences.commandPath;
    if (!state.localAllowed || !state.preferences.quickUpdateEnabled || !command)
      return yield* fail("请在设置中启用快捷更新并选择配套 CMD。");
    if (/[\r\n%]/.test(command) || path.extname(command).toLowerCase() !== ".cmd")
      return yield* fail("请选择路径中不含 % 或换行的 CMD 迁移入口。");
    if (!(yield* fs.exists(command))) return yield* fail("CMD 文件已不存在，请在设置中重新选择。");
    const directory = path.dirname(command);
    for (const relative of [
      "release.json",
      "release/release.json",
      "t3code/release/release.json",
    ]) {
      const manifestPath = path.join(directory, relative);
      if (!(yield* fs.exists(manifestPath))) continue;
      const manifest = yield* fs.readFileString(manifestPath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PortableUpdateManifest))),
        Effect.mapError(
          () =>
            new UpdateCenterError({
              detail: "本地包清单缺少有效构建来源，请使用新版打包流程重新打包。",
            }),
        ),
      );
      return { manifest, command };
    }
    return yield* fail("所选 CMD 旁未找到配套 release.json。请先完成打包，或重新选择迁移入口。");
  });

  const checkSources = Effect.fn("desktop.updateCenter.checkSources")(function* (
    checkRemote: boolean,
  ) {
    const state = yield* Ref.get(stateRef);
    if (!state.supported || !state.preferences.checkingEnabled || state.installing) return state;
    const now = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const runSource = Effect.fn("desktop.updateCenter.runSource")(function* <E, R>(
      key: "upstream" | "repository" | "local",
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
    if (checkRemote) {
      yield* Ref.set(lastRemote, now);
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
            const release = yield* json("pingdotgg/t3code/releases/latest").pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(GithubRelease)),
            );
            const version = release.tag_name.replace(/^v/, "");
            const notes = normalizeDesktopUpdateReleaseNotes(
              release.body,
              version,
              "latest",
              release.published_at ?? undefined,
            ).releaseNotes[0];
            return {
              ...compareUpstream(build, version),
              url: release.html_url,
              ...(notes ? { releaseNotes: notes } : {}),
            };
          }),
        ),
      );
      tasks.push(
        runSource(
          "repository",
          Effect.gen(function* () {
            if (
              !/^[\w.-]+\/[\w.-]+$/.test(build.repository) ||
              !build.sourceBranch ||
              !build.sourceRevision
            )
              return {
                ...state.repository,
                status: "unsupported" as const,
                message: "当前包缺少仓库、分支或提交信息，请安装新版 Plus 包。",
              };
            const branch = yield* json(
              `${build.repository}/branches/${encodeURIComponent(build.sourceBranch)}`,
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GithubBranch)));
            const latest = branch.commit.sha;
            const url = `https://github.com/${build.repository}/compare/${build.sourceRevision}...${latest}`;
            if (latest === build.sourceRevision)
              return {
                ...state.repository,
                status: "current" as const,
                latest,
                url,
                message: null,
                commits: [updateCommit(branch.commit)],
                commitCount: 1,
              };
            const comparison = yield* json(
              `${build.repository}/compare/${build.sourceRevision}...${latest}`,
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GithubComparison)));
            return {
              ...state.repository,
              latest,
              url,
              status: repositoryUpdateStatus(comparison.status),
              commits: comparison.commits.slice(-MAX_UPDATE_COMMITS).reverse().map(updateCommit),
              commitCount: comparison.ahead_by,
              message:
                comparison.status === "diverged"
                  ? "当前构建与远端分支历史已分叉。"
                  : `远端领先 ${comparison.ahead_by} 个提交，当前领先 ${comparison.behind_by} 个提交。`,
            };
          }),
        ),
      );
    }
    if (state.localAllowed && state.preferences.quickUpdateEnabled)
      tasks.push(
        runSource(
          "local",
          readLocal().pipe(Effect.map(({ manifest }) => compareLocalPackage(build, manifest))),
        ),
      );
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
          remote || (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastRemote)) >= 1800000;
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
    const running = yield* Ref.getAndSet(checkRef, null);
    if (running) yield* Fiber.interrupt(running.fiber);
    const state = yield* Ref.get(stateRef);
    yield* publish(
      Object.fromEntries(
        (["upstream", "repository", "local"] as const)
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
      check(false).pipe(Effect.asVoid, Effect.repeat(Schedule.spaced("60 seconds")), Effect.asVoid),
      scope,
    );
    yield* Ref.set(timerRef, timer);
  });

  const chooseCommand = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (!state.localAllowed) return yield* fail("快捷更新仅限 develop 分支的 Windows 安装包。");
    const files = yield* dialog.pickFiles({
      owner: yield* windows.focusedMainOrFirst,
      defaultPath: Option.fromNullishOr(state.preferences.commandPath),
      filters: [{ name: "T3 Code Plus 迁移入口", extensions: ["cmd"] }],
      multiple: false,
    });
    const commandPath = files[0];
    if (!commandPath) return state;
    if (/[\r\n%]/.test(commandPath)) return yield* fail("CMD 路径不能包含 % 或换行。");
    const preferences = { ...state.preferences, commandPath, quickUpdateEnabled: true };
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
      return yield* fail("当前客户端未开启 develop 快捷更新。");
    const { manifest, command } = yield* readLocal();
    const source = compareLocalPackage(build, manifest);
    if (source.status !== "available")
      return yield* fail(source.message ?? "没有可安装的更新版本。");
    if (path.basename(path.dirname(executable)).toLowerCase() !== "win-unpacked")
      return yield* fail("快捷更新需要完整的 win-unpacked 安装目录。");
    const scriptSource = yield* assets.resolveResourcePath("local-update.ps1");
    if (Option.isNone(scriptSource))
      return yield* fail("当前包缺少本地更新协调器，请重新安装完整包。");
    const temporary = yield* fs.makeTempDirectory({ prefix: "t3code-local-update-" });
    const script = path.join(temporary, "local-update.ps1");
    const requestPath = path.join(temporary, "request.json");
    // Windows PowerShell 5 reads UTF-8 source correctly only when it has a BOM.
    yield* fs.writeFileString(
      script,
      `\uFEFF${(yield* fs.readFileString(scriptSource.value)).replace(/^\uFEFF/, "")}`,
    );
    const destinationRoot = path.dirname(path.dirname(executable));
    if (/[\r\n%]/.test(destinationRoot)) return yield* fail("当前安装目录不能包含 % 或换行。");
    yield* fs.writeFileString(
      requestPath,
      yield* encodeUpdateRequest({
        commandPath: command,
        destinationRoot,
        executableName: path.basename(executable),
        targetVersion: manifest.version,
        sourceBranch: build.sourceBranch,
        parentPid: process.pid,
      }),
    );
    yield* publish({ installing: true });
    const handoff = Effect.gen(function* () {
      yield* runWindowsLocalUpdate(script, requestPath, true);
      const owner = Option.getOrUndefined(yield* windows.focusedMainOrFirst);
      const answer = yield* dialog.showMessageBox(
        {
          type: "question",
          title: "更新 T3 Code Plus",
          message: `退出并更新到 ${manifest.version}？`,
          detail: `当前版本：${build.artifactVersion}\n安装目录：${destinationRoot}\n\n客户端和本机托管的运行任务将正常退出。安装成功后自动打开新客户端，迁移器保留旧版备份。`,
          buttons: ["取消", "退出并更新"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        },
        owner,
      );
      if (answer.response !== 1) return false;
      yield* stop;
      yield* runWindowsLocalUpdate(script, requestPath, false).pipe(Effect.tapError(() => restart));
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
    chooseCommand: actionGate.withPermits(1)(chooseCommand).pipe(Effect.mapError(asUpdateError)),
    configure: Effect.fn("desktop.updateCenter.configure")(function (change) {
      return actionGate
        .withPermits(1)(
          Effect.gen(function* () {
            const state = yield* Ref.get(stateRef);
            if (change.quickUpdateEnabled && !state.localAllowed)
              return yield* fail("快捷更新仅限 develop 分支的 Windows 安装包。");
            if (
              change.quickUpdateEnabled &&
              (!state.preferences.commandPath || !(yield* fs.exists(state.preferences.commandPath)))
            )
              return yield* chooseCommand;
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
