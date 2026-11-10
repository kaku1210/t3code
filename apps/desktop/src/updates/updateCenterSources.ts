import { DesktopBuildInfo, type DesktopUpdateSource } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export const PortableUpdateManifest = Schema.Struct({
  appName: Schema.String,
  version: Schema.String,
  buildInfo: DesktopBuildInfo,
});
export type PortableUpdateManifest = typeof PortableUpdateManifest.Type;

export function updateSource(current: string | null): DesktopUpdateSource {
  return {
    status: "idle",
    current,
    latest: null,
    message: null,
    url: null,
    checkedAt: null,
    majorUpdate: false,
  };
}

export function supportsLocalUpdate(build: DesktopBuildInfo, packaged: boolean): boolean {
  return packaged && build.platform === "win32" && build.sourceBranch === "develop";
}

export function compareUpstream(build: DesktopBuildInfo, version: string): DesktopUpdateSource {
  const source = updateSource(build.upstreamVersion);
  const current = build.upstreamVersion && parseSemver(build.upstreamVersion);
  const latest = parseSemver(version);
  if (!current || !latest)
    return {
      ...source,
      status: "unsupported",
      message: "无法比较上游版本：构建信息或发布版本无效。",
    };
  const comparison = compareSemverVersions(version, build.upstreamVersion!);
  return {
    ...source,
    latest: version,
    status: comparison > 0 ? "available" : comparison < 0 ? "ahead" : "current",
    majorUpdate: latest.major > current.major,
  };
}

/** A package must carry the same immutable source identity; a SHA difference alone is not a release. */
export function compareLocalPackage(
  build: DesktopBuildInfo,
  manifest: PortableUpdateManifest,
): DesktopUpdateSource {
  const source = { ...updateSource(build.artifactVersion), latest: manifest.version };
  const target = manifest.buildInfo;
  if (
    target.sourceBranch !== build.sourceBranch ||
    target.repository !== build.repository ||
    target.platform !== build.platform ||
    target.arch !== build.arch
  ) {
    return {
      ...source,
      status: "unsupported",
      message: "待安装包的仓库、分支、平台或架构与当前客户端不一致。",
    };
  }
  const plusVersion = /^\d+\.\d+\.\d+-plus\.\d{8}\.\d+$/;
  if (
    !plusVersion.test(build.artifactVersion) ||
    !plusVersion.test(manifest.version) ||
    target.artifactVersion !== manifest.version
  ) {
    return {
      ...source,
      status: "unsupported",
      message: "待安装包缺少有效的 Plus 版本信息，请重新打包。",
    };
  }
  const comparison = compareSemverVersions(manifest.version, build.artifactVersion);
  return {
    ...source,
    status: comparison > 0 ? "available" : comparison < 0 ? "ahead" : "current",
    message:
      comparison === 0 && target.sourceRevision !== build.sourceRevision
        ? "版本号相同但提交不同，请增加打包序号。"
        : null,
  };
}

export function repositoryUpdateStatus(status: string): DesktopUpdateSource["status"] {
  switch (status) {
    case "identical":
      return "current";
    case "ahead":
      return "available";
    case "behind":
      return "ahead";
    case "diverged":
      return "diverged";
    default:
      return "error";
  }
}
