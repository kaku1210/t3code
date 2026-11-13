import { assert, describe, it } from "@effect/vitest";
import type { DesktopBuildInfo } from "@t3tools/contracts";
import {
  branchFeedCommits,
  compareBranchCommits,
  compareLocalPackage,
  compareLocalSource,
  compareRelease,
  compareUpstream,
  releaseManifestVersion,
  supportsLocalUpdate,
} from "./updateCenterSources.ts";

const build: DesktopBuildInfo = {
  artifactVersion: "0.1.7-plus.20261109.3",
  upstreamVersion: "0.1.7",
  repository: "kaku1210/t3code",
  sourceBranch: "develop",
  sourceRevision: "a".repeat(40),
  sourceDirty: true,
  builtAt: "2026-11-09T00:00:00Z",
  platform: "win32",
  arch: "x64",
};
const manifest = (changes: Partial<DesktopBuildInfo> = {}) => {
  const target = { ...build, artifactVersion: "0.1.7-plus.20261109.4", ...changes };
  return {
    version: target.artifactVersion,
    installer: `T3-Code-Plus-${target.artifactVersion}-x64.exe`,
    buildInfo: target,
  };
};
const cleanSource = { dirty: false, commitsSinceInstalled: 0, commitsSincePackage: 0 };

describe("update source comparisons", () => {
  it.each([
    ["0.1.7", "current", false],
    ["0.1.8", "available", false],
    ["1.0.0", "available", true],
    ["0.1.6", "ahead", false],
    ["invalid", "unsupported", false],
  ] as const)("compares upstream %s independently of the Plus suffix", (version, status, major) => {
    const result = compareUpstream(build, version);
    assert.equal(result.status, status);
    assert.equal(result.majorUpdate, major);
    assert.equal(
      compareUpstream({ ...build, upstreamVersion: null }, version).status,
      "unsupported",
    );
  });
  it.each([
    ["0.1.7-plus.20261109.4", "available", false],
    ["0.1.8-plus.20261101.1", "available", false],
    ["1.0.0-plus.20261101.1", "available", true],
    [build.artifactVersion, "current", false],
    ["0.1.7-plus.20261109.2", "ahead", false],
    ["0.1.7", "available", false],
    ["not-a-version", "unsupported", false],
  ] as const)(
    "compares the published release %s with the installed package",
    (version, status, major) => {
      const result = compareRelease(build, version);
      assert.equal(result.status, status);
      assert.equal(result.majorUpdate, major);
    },
  );
  it("offers local updates only to packaged Windows development builds", () => {
    assert.isTrue(supportsLocalUpdate(build, true));
    assert.isTrue(supportsLocalUpdate({ ...build, sourceBranch: "feature/x" }, true));
    assert.isFalse(supportsLocalUpdate({ ...build, sourceBranch: "main" }, true));
    assert.isFalse(supportsLocalUpdate(build, false));
    assert.isFalse(supportsLocalUpdate({ ...build, platform: "darwin" }, true));
  });
  it.each([
    [{ sourceBranch: "main" }, "available"],
    [{ arch: "arm64" }, "unsupported"],
    [{ platform: "darwin" }, "unsupported"],
    [{ repository: "other/fork" }, "unsupported"],
    [{ artifactVersion: "0.1.7-plus.20261109.4" }, "available"],
    [{ artifactVersion: "0.1.7-plus.20261110.1" }, "available"],
    [{ artifactVersion: "0.1.8-plus.20261101.1" }, "available"],
    [{ artifactVersion: "0.1.7-plus.20261109.2" }, "ahead"],
    [{ artifactVersion: build.artifactVersion }, "current"],
    [{ artifactVersion: "1.0.0-dev.1" }, "unsupported"],
  ] as const)("validates local package %j", (changes, status) =>
    assert.equal(compareLocalPackage(build, manifest(changes)).status, status),
  );
  it("rejects inconsistent versions rather than reporting an available package", () => {
    assert.equal(
      compareLocalPackage(build, { ...manifest(), version: "0.1.7-plus.20261109.5" }).status,
      "unsupported",
    );
    const sameVersion = compareLocalPackage(
      build,
      manifest({ artifactVersion: build.artifactVersion, sourceRevision: "b".repeat(40) }),
    );
    assert.equal(sameVersion.status, "current");
    assert.include(sameVersion.message!, "增加打包序号");
  });
  it.each([
    ["no package, unchanged source", null, cleanSource, "current", null],
    [
      "no package, new commits",
      null,
      { ...cleanSource, commitsSinceInstalled: 3 },
      "needs-build",
      "3 个新提交",
    ],
    [
      "built package, then new commits",
      manifest(),
      { ...cleanSource, commitsSinceInstalled: 4, commitsSincePackage: 1 },
      "available",
      "打包后源码又有1 个新提交",
    ],
    ["fresh package", manifest(), { ...cleanSource, commitsSinceInstalled: 4 }, "available", null],
    [
      "installed package, source moved on",
      manifest({ artifactVersion: build.artifactVersion }),
      { ...cleanSource, commitsSinceInstalled: 2, commitsSincePackage: 2 },
      "needs-build",
      "2 个新提交",
    ],
    [
      "installed revision missing from the checkout",
      null,
      { ...cleanSource, commitsSinceInstalled: null },
      "unsupported",
      "找不到当前安装版本的提交",
    ],
  ] as const)("reports the checkout state: %s", (_name, local, source, status, message) => {
    const result = compareLocalSource(build, local, source);
    assert.equal(result.status, status);
    if (message) assert.include(result.message ?? "", message);
    else assert.isNull(result.message);
  });
  it("counts uncommitted changes only against a clean build", () => {
    const dirty = { ...cleanSource, dirty: true };
    assert.equal(compareLocalSource(build, null, dirty).status, "current");
    assert.equal(
      compareLocalSource({ ...build, sourceDirty: false }, null, dirty).status,
      "needs-build",
    );
    assert.include(
      compareLocalSource(build, manifest({ sourceDirty: false }), dirty).message ?? "",
      "未提交修改",
    );
  });
  it.each([
    ["version: 0.1.9\nfiles: []", "0.1.9"],
    ["files: []\nversion: '0.1.7-plus.20261113.1'\n", "0.1.7-plus.20261113.1"],
    ['version: "1.0.0"', "1.0.0"],
    ["files: []", null],
  ] as const)("reads the release version from latest.yml %j", (manifest, version) =>
    assert.equal(releaseManifestVersion(manifest), version),
  );
  it("decodes a commit feed entry's doubly escaped message", () => {
    // Trimmed from https://github.com/kaku1210/t3code/commits/develop.atom
    const feed = `<feed><entry>
    <id>tag:github.com,2008:Grit::Commit/${"b".repeat(40)}</id>
    <link type="text/html" rel="alternate" href="https://github.com/kaku1210/t3code/commit/${"b".repeat(40)}"/>
    <title>
        docs(agents): never launch the installed app
    </title>
    <content type="html">
      &lt;pre style=&#39;white-space:pre-wrap;width:81ex&#39;&gt;docs(agents): never launch the installed app

Co-Authored-By: Claude &amp;lt;noreply@anthropic.com&amp;gt;&lt;/pre&gt;
    </content>
  </entry></feed>`;
    assert.deepEqual(branchFeedCommits(feed), [
      {
        sha: "b".repeat(40),
        message:
          "docs(agents): never launch the installed app\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        url: `https://github.com/kaku1210/t3code/commit/${"b".repeat(40)}`,
      },
    ]);
  });
  it("places the installed revision among the branch's recent commits", () => {
    const commit = (sha: string) => ({ sha, message: sha, url: "" });
    const installed = commit(build.sourceRevision!);
    assert.equal(compareBranchCommits(build, [installed]).status, "current");
    const behind = compareBranchCommits(build, [commit("c".repeat(40)), installed]);
    assert.equal(behind.status, "available");
    assert.equal(behind.commitCount, 1);
    assert.equal(compareBranchCommits(build, [commit("c".repeat(40))]).status, "unsupported");
    assert.equal(compareBranchCommits(build, []).status, "error");
  });
});
