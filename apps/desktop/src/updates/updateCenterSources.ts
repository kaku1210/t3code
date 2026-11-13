import {
  isReleaseBuild,
  type DesktopBuildInfo,
  type DesktopLocalPackageInfo,
  type DesktopUpdateCommit,
  type DesktopUpdateSource,
} from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

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
  return packaged && build.platform === "win32" && !isReleaseBuild(build);
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

/** The published Plus release against the installed package; both carry the full Plus version. */
export function compareRelease(build: DesktopBuildInfo, version: string): DesktopUpdateSource {
  const source = updateSource(build.artifactVersion);
  const current = parseSemver(build.artifactVersion);
  const latest = parseSemver(version);
  if (!current || !latest)
    return {
      ...source,
      latest: version,
      status: "unsupported",
      message: "无法比较发布版本：当前版本或发布版本号无效。",
    };
  const comparison = compareSemverVersions(version, build.artifactVersion);
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
  local: DesktopLocalPackageInfo,
): DesktopUpdateSource {
  const source = { ...updateSource(build.artifactVersion), latest: local.version };
  const target = local.buildInfo;
  if (
    target.repository !== build.repository ||
    target.platform !== build.platform ||
    target.arch !== build.arch
  ) {
    return {
      ...source,
      status: "unsupported",
      message: "待安装包的仓库、平台或架构与当前客户端不一致。",
    };
  }
  const plusVersion = /^\d+\.\d+\.\d+-plus\.\d{8}\.\d+$/;
  if (
    !plusVersion.test(build.artifactVersion) ||
    !plusVersion.test(local.version) ||
    target.artifactVersion !== local.version
  ) {
    return {
      ...source,
      status: "unsupported",
      message: "待安装包缺少有效的 Plus 版本信息，请重新打包。",
    };
  }
  const comparison = compareSemverVersions(local.version, build.artifactVersion);
  return {
    ...source,
    status: comparison > 0 ? "available" : comparison < 0 ? "ahead" : "current",
    message:
      comparison === 0 && target.sourceRevision !== build.sourceRevision
        ? "版本号相同但提交不同，请增加打包序号。"
        : null,
  };
}

/** Source checkout state; a count is null when that revision is not in the checkout's history. */
export interface LocalSourceState {
  readonly dirty: boolean;
  readonly commitsSinceInstalled: number | null;
  readonly commitsSincePackage: number | null;
}

const PACKAGE_COMMAND = "vp run dist:desktop:win";

const changeSummary = (commits: number, dirty: boolean) =>
  [commits > 0 ? `${commits} 个新提交` : null, dirty ? "未提交修改" : null]
    .filter(Boolean)
    .join("和");

/**
 * Combines the checkout's prepared installer with its Git state. Uncommitted changes count only
 * when the build being compared was clean, since a dirty build may already contain them.
 */
export function compareLocalSource(
  build: DesktopBuildInfo,
  local: DesktopLocalPackageInfo | null,
  source: LocalSourceState,
): DesktopUpdateSource {
  const packaged = local ? compareLocalPackage(build, local) : null;
  if (packaged?.status === "available") {
    const commits = source.commitsSincePackage ?? 0;
    const dirty = source.dirty && !local!.buildInfo.sourceDirty;
    return commits > 0 || dirty
      ? {
          ...packaged,
          message: `打包后源码又有${changeSummary(commits, dirty)}。可以先安装此包，或运行 ${PACKAGE_COMMAND} 重新打包。`,
        }
      : packaged;
  }
  if (packaged?.status === "unsupported") return packaged;
  const base = packaged ?? updateSource(build.artifactVersion);
  if (source.commitsSinceInstalled === null)
    return {
      ...base,
      status: "unsupported",
      message: "源码仓库中找不到当前安装版本的提交，无法比较。请确认选择的是打包所用的仓库。",
    };
  const dirty = source.dirty && !build.sourceDirty;
  if (source.commitsSinceInstalled > 0 || dirty)
    return {
      ...base,
      status: "needs-build",
      message: `源码比当前安装版本多${changeSummary(source.commitsSinceInstalled, dirty)}。运行 ${PACKAGE_COMMAND} 重新打包后即可安装。`,
    };
  return { ...base, status: packaged?.status ?? "current" };
}

const MAX_UPDATE_COMMITS = 12;

/** Places the build's revision in the branch's recent commits, which the feed lists newest first. */
export function compareBranchCommits(
  build: DesktopBuildInfo,
  commits: readonly DesktopUpdateCommit[],
): DesktopUpdateSource {
  const source = updateSource(build.sourceRevision);
  const latest = commits[0];
  if (!latest) return { ...source, status: "error", message: "无法读取远端分支的提交。" };
  const behind = commits.findIndex((commit) => commit.sha === build.sourceRevision);
  if (behind === 0)
    return { ...source, status: "current", latest: latest.sha, commits: [latest], commitCount: 1 };
  if (behind > 0)
    return {
      ...source,
      status: "available",
      latest: latest.sha,
      commits: commits.slice(0, Math.min(behind, MAX_UPDATE_COMMITS)),
      commitCount: behind,
      message: `远端领先 ${behind} 个提交。`,
    };
  return {
    ...source,
    status: "unsupported",
    latest: latest.sha,
    message: `远端分支最近 ${commits.length} 个提交里没有当前构建的提交：远端可能领先更多，或当前构建包含未推送的提交。`,
  };
}

/** Reads `version` from an electron-builder `latest.yml`. */
export function releaseManifestVersion(manifest: string): string | null {
  return /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(manifest)?.[1] ?? null;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

interface AtomEntry {
  readonly id: string;
  readonly link: string;
  readonly title: string;
  /** The entry's HTML, with the feed's own XML escaping removed. */
  readonly content: string;
  readonly updated: string | null;
}

const elementText = (body: string, name: string) =>
  new RegExp(String.raw`<${name}\b[^>]*>([\s\S]*?)</${name}>`).exec(body)?.[1] ?? "";

function atomEntries(feed: string): AtomEntry[] {
  return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, body = ""]) => ({
    id: decodeXmlEntities(elementText(body, "id")).trim(),
    link: decodeXmlEntities(/<link\b[^>]*\bhref="([^"]*)"/.exec(body)?.[1] ?? ""),
    title: decodeXmlEntities(elementText(body, "title")).trim(),
    content: decodeXmlEntities(elementText(body, "content")).trim(),
    updated: elementText(body, "updated").trim() || null,
  }));
}

/** The `releases.atom` entry for a tag, whose content is the rendered release notes. */
export function releaseFeedEntry(
  feed: string,
  tag: string,
): { readonly notesHtml: string; readonly updated: string | null } | null {
  const entry = atomEntries(feed).find((candidate) =>
    candidate.link.endsWith(`/releases/tag/${tag}`),
  );
  return entry ? { notesHtml: entry.content, updated: entry.updated } : null;
}

/** Commits from a `commits/<branch>.atom` feed, newest first, with their full messages. */
export function branchFeedCommits(feed: string): DesktopUpdateCommit[] {
  return atomEntries(feed).flatMap((entry) => {
    const sha = /Commit\/([0-9a-f]{40})$/i.exec(entry.id)?.[1];
    if (!sha) return [];
    // The message is HTML-escaped inside a <pre>, so it needs a second decode.
    const message = decodeXmlEntities(entry.content.replace(/^<pre\b[^>]*>|<\/pre>$/g, "")).trim();
    return [{ sha, message: message || entry.title, url: entry.link }];
  });
}
