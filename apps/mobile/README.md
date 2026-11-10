# T3 Code Mobile

> [!NOTE]
> To install the released app from the App Store or Google Play, see [Mobile app](../../docs/user/install.md#mobile-app). This guide covers building it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Plus Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Plus Preview`
- `production`: store/release build as `T3 Code Plus`

Run commands from `apps/mobile`.

## Fork builds on a Devin cloud Mac

For the repeatable TestFlight procedure, cache reuse, recovery steps and the verified build
baseline, see [T3 Code Plus cloud Mac releases](../../docs/operations/mobile-testflight.md).

Use the existing Devin attachment handoff and Apple signing/upload process used by the other
projects. Send a fixed source revision or an explicitly selected source snapshot; exclude local
environment files, credentials, caches and installed dependencies. This app uses Expo and React
Native, so generate its native iOS project on the Mac before archiving with Xcode; the Unity
export and Unity-iPhone scheme in those projects do not apply here.

Before a signed build, verify the App Store Connect record against `ios-release.json`, and check
that the version/build is unused. Reuse an existing matching team certificate only after checking
it; provisioning profiles must match this app and its widget/share extensions. Native identities
and keychain/app groups are derived in `app.config.ts`; `eas.json` points at the same app record.

This fork's release identity is recorded in [`ios-release.json`](ios-release.json):
`T3 Code Plus`, `com.tingfeng.t3codeplus`, Team `L9NF344PND`, App Store Connect
`6832172519`, internal TestFlight group `Self`. Version/build must be checked against Apple before
upload. OTA is disabled in this fork until a separate Expo project is configured. The initial
build supports direct pairing with existing desktop servers; verified hosted links and cloud
sign-in require separately configured services owned by the fork.

Check the Mac's installed Node/package-manager versions against the root `package.json`, plus
Xcode, CocoaPods, free space and signing access. Do not install or upgrade system tools as part
of that check. Generate the first native project with `expo prebuild --platform ios`. Expo SDK 58
recreates native folders by default; on an existing build workspace, use
`expo prebuild --platform ios --no-clean --no-install` to preserve the generated project and Pods.
If native dependencies changed, update Pods before archiving. Archive the generated workspace and
its actual scheme in Release for a generic iOS device. Export the App Store Connect IPA and retain
the matching archive/dSYMs. This build must run without Metro.

Upload, Apple processing, TestFlight group availability and an actual iPhone run are separate
results. Only upload after the app identity and distribution scope are confirmed. The upstream
`mobile-eas-production.yml` is restricted to the official repository and is not this fork's
Devin build entry point.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

For simulator, emulator, or Android phone development, boot or connect a device, then install the
native client that matches this checkout before starting Metro:

```bash
vp run mobile:install ios [simulator-udid]
# Or: vp run mobile:install android [emulator-or-phone-serial]
vp run dev:client
```

The device argument can be omitted when exactly one device is booted or connected. The helper
compares this checkout's Expo fingerprint and the installed binary with its last install record,
and reuses a matching client. Otherwise it installs the build for that fingerprint from
`~/.cache/t3code/native-clients/artifacts`, then the shared task cache, and builds only when
neither has it. One iOS simulator build serves every iPhone and iPad simulator, and one APK per
ABI (x86_64 or arm64-v8a) serves every emulator and phone of that ABI. Build output goes to the
log file it prints (`T3_NATIVE_CLIENT_VERBOSE=1` streams it instead). Builds are shared back when
your task-cache login (`bash infra/task-cache/install.sh`) can write. `T3_NATIVE_CLIENT_CACHE=read`
skips the upload and `off` skips the shared cache. Physical iPhones still use `vp run ios:dev`.

`--session <name>` installs into an agent-device session opened elsewhere, such as a device pool
or a cloud simulator, instead of a local device: `vp run mobile:install android --session pool-1
--metro http://<this-machine>:8081`. It uses only the cached build (x86_64 by default; `--abi`
for ARM) and fails with the next step when no machine has built this fingerprint yet.

For a read-only decision, run `node ../../scripts/mobile-native-client.ts check <ios|android>
[device]`: exit 0 means compatible, 2 means an install is needed, and 1 means an operational error.
An externally installed client is unverified until the helper installs it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
