import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopUpdateReleaseNoteSchema } from "./ipc.ts";

/** Immutable source information recorded when a Plus artifact is built. */
export const DesktopBuildInfo = Schema.Struct({
  artifactVersion: Schema.String,
  upstreamVersion: Schema.NullOr(Schema.String),
  repository: Schema.String,
  sourceBranch: Schema.NullOr(Schema.String),
  sourceRevision: Schema.NullOr(Schema.String),
  sourceDirty: Schema.Boolean,
  builtAt: Schema.NullOr(Schema.String),
  platform: Schema.String,
  arch: Schema.String,
});
export type DesktopBuildInfo = typeof DesktopBuildInfo.Type;

/** `main` builds are what other machines install; every other branch is a development build. */
export function isReleaseBuild(build: Pick<DesktopBuildInfo, "sourceBranch">): boolean {
  return build.sourceBranch === "main";
}

/** Name of the file a Windows installer build writes beside its NSIS installer in `release/`. */
export const LOCAL_PACKAGE_INFO_FILE = "local-package.json";
/** Touching this file in `release/` asks a client watching the checkout to compare it again. */
export const LOCAL_UPDATE_REFRESH_FILE = ".refresh-local-update";

/** Describes the newest installer in a checkout's `release/` directory for quick local updates. */
export const DesktopLocalPackageInfo = Schema.Struct({
  version: Schema.String,
  /** Installer file name inside the same `release/` directory. */
  installer: Schema.String,
  buildInfo: DesktopBuildInfo,
});
export type DesktopLocalPackageInfo = typeof DesktopLocalPackageInfo.Type;

export const DesktopUpdateCenterPreferences = Schema.Struct({
  checkingEnabled: Schema.Boolean,
  quickUpdateEnabled: Schema.Boolean,
  /** Local T3 Code Plus checkout whose `release/` directory holds the installer to apply. */
  sourcePath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type DesktopUpdateCenterPreferences = typeof DesktopUpdateCenterPreferences.Type;

export const DEFAULT_UPDATE_CENTER_PREFERENCES: DesktopUpdateCenterPreferences = {
  checkingEnabled: true,
  quickUpdateEnabled: false,
  sourcePath: null,
};

/** A GitHub commit returned for the checked branch or update range. */
export const DesktopUpdateCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  url: Schema.String,
});
export type DesktopUpdateCommit = typeof DesktopUpdateCommit.Type;

export const DesktopUpdateSource = Schema.Struct({
  status: Schema.Literals([
    "idle",
    "checking",
    "current",
    "available",
    "needs-build",
    "ahead",
    "diverged",
    "error",
    "unsupported",
  ]),
  current: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
  majorUpdate: Schema.Boolean,
  releaseNotes: Schema.optionalKey(DesktopUpdateReleaseNoteSchema),
  commits: Schema.optionalKey(Schema.Array(DesktopUpdateCommit)),
  commitCount: Schema.optionalKey(Schema.Number),
});
export type DesktopUpdateSource = typeof DesktopUpdateSource.Type;

export const DesktopUpdateCenterState = Schema.Struct({
  supported: Schema.Boolean,
  localAllowed: Schema.Boolean,
  preferences: DesktopUpdateCenterPreferences,
  build: DesktopBuildInfo,
  upstream: DesktopUpdateSource,
  repository: DesktopUpdateSource,
  /** Latest published T3 Code Plus release, which the built-in updater installs. */
  release: DesktopUpdateSource,
  local: DesktopUpdateSource,
  installing: Schema.Boolean,
});
export type DesktopUpdateCenterState = typeof DesktopUpdateCenterState.Type;

export const DesktopUpdateCenterChange = Schema.Struct({
  checkingEnabled: Schema.optional(Schema.Boolean),
  quickUpdateEnabled: Schema.optional(Schema.Boolean),
});
export type DesktopUpdateCenterChange = typeof DesktopUpdateCenterChange.Type;

/** Windows-only local operations; remote clients cannot execute an updater command. */
export interface DesktopUpdateCenterBridge {
  getState(): Promise<DesktopUpdateCenterState>;
  configure(change: DesktopUpdateCenterChange): Promise<DesktopUpdateCenterState>;
  chooseSource(): Promise<DesktopUpdateCenterState>;
  check(): Promise<DesktopUpdateCenterState>;
  install(): Promise<boolean>;
  onState(listener: (state: DesktopUpdateCenterState) => void): () => void;
}
