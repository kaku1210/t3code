import { afterEach, expect, it, vi } from "vite-plus/test";

import easConfig from "./eas.json" with { type: "json" };
import iosRelease from "./ios-release.json" with { type: "json" };

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.tingfeng.t3codeplus"],
  ["development", "com.tingfeng.t3codeplus.dev"],
  ["preview", "com.tingfeng.t3codeplus.preview"],
  ["production", "com.tingfeng.t3codeplus"],
])("uses independent signed identities for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.appleTeamId).toBe("L9NF344PND");
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${identifier}`,
  ]);
  expect(config.plugins).toContainEqual([
    "expo-widgets",
    expect.objectContaining({
      bundleIdentifier: `${identifier}.widgets`,
      groupIdentifier: `group.${identifier}`,
    }),
  ]);
  // This fork cannot register itself in the upstream domain or receive its OTA JavaScript.
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.version).toBe(iosRelease.version);
  expect(config.ios?.buildNumber).toBe(iosRelease.buildNumber);
  expect(easConfig.submit.production.ios.ascAppId).toBe(iosRelease.appStoreConnectAppId);
});
