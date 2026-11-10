import { assert, describe, it } from "@effect/vitest";
import type { DesktopBuildInfo } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  compareLocalPackage,
  compareUpstream,
  PortableUpdateManifest,
  repositoryUpdateStatus,
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
const isPortableManifest = Schema.is(PortableUpdateManifest);
const manifest = (changes: Partial<DesktopBuildInfo> = {}) => {
  const target = { ...build, artifactVersion: "0.1.7-plus.20261109.4", ...changes };
  return { appName: "T3 Code Plus", version: target.artifactVersion, buildInfo: target };
};

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
  it.each(["main", "dev", "feature/develop", null])(
    "does not enable local update for branch %s",
    (sourceBranch) => {
      assert.isFalse(supportsLocalUpdate({ ...build, sourceBranch }, true));
    },
  );
  it("requires a packaged Windows develop build", () => {
    assert.isTrue(supportsLocalUpdate(build, true));
    assert.isFalse(supportsLocalUpdate(build, false));
    assert.isFalse(supportsLocalUpdate({ ...build, platform: "darwin" }, true));
  });
  it.each([
    [{ sourceBranch: "main" }, "unsupported"],
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
  it("rejects old metadata and inconsistent versions rather than reporting an available package", () => {
    assert.isFalse(
      isPortableManifest({
        appName: "T3 Code Plus",
        version: "0.1.7-plus.20261109.4",
      }),
    );
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
    ["ahead", "available"],
    ["behind", "ahead"],
    ["identical", "current"],
    ["diverged", "diverged"],
    ["unexpected", "error"],
  ] as const)("preserves Git compare direction %s", (comparison, status) =>
    assert.equal(repositoryUpdateStatus(comparison), status),
  );
});
