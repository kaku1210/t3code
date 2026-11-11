import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Hex from "effect/encoding/Hex";
import * as Toml from "effect/encoding/Toml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const PROVIDER = { id: "devin", label: "Devin" } as const;
// Allow the proxy tunnel and TLS handshake to finish within the overall 30-second check.
const PROXY_CONNECT_TIMEOUT_MS = 20_000;
const Credentials = Schema.Struct({
  windsurf_api_key: Schema.optional(Schema.NonEmptyString),
  api_server_url: Schema.optional(Schema.NonEmptyString),
});
const Percentage = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Reset = Schema.Union([Schema.String, Schema.Number]);
const UserStatus = Schema.Struct({
  userStatus: Schema.Struct({
    userId: Schema.NonEmptyString,
    email: Schema.optional(Schema.String),
    planStatus: Schema.Struct({
      planInfo: Schema.optional(Schema.Struct({ planName: Schema.optional(Schema.String) })),
      planEnd: Schema.optional(Schema.String),
      dailyQuotaRemainingPercent: Schema.optional(Percentage),
      weeklyQuotaRemainingPercent: Schema.optional(Percentage),
      dailyQuotaResetAtUnix: Schema.optional(Reset),
      weeklyQuotaResetAtUnix: Schema.optional(Reset),
    }),
  }),
});
const decodeCredentials = Schema.decodeUnknownEffect(Credentials);
const decodeServer = Schema.decodeEffect(Schema.URLFromString);
const decodeUserStatus = HttpClientResponse.schemaBodyJson(UserStatus);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Windows uses its system TLS client for proxy tunnels; the login key travels only over stdin. */
const readWindowsDevinStatus = Effect.fn("DevinUsageLimits.readWindowsStatus")(function* (
  request: HttpClientRequest.HttpClientRequest,
  body: string,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? "";
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? httpProxy;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      path.join(
        environment.SystemRoot ?? hostEnvironment.SystemRoot ?? "C:\\Windows",
        "System32",
        "curl.exe",
      ),
      [
        "--disable",
        "--http1.1",
        "--silent",
        "--show-error",
        "--compressed",
        "--connect-timeout",
        "20",
        "--max-time",
        "25",
        "--proto",
        "=https",
        "--request",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--header",
        "Connect-Protocol-Version: 1",
        "--data-binary",
        "@-",
        "--write-out",
        "\n%{http_code}",
        request.url,
      ],
      {
        stdin: Stream.make(new TextEncoder().encode(body)),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HTTP_PROXY: httpProxy,
          HTTPS_PROXY: httpsProxy,
          NO_PROXY: environment.no_proxy ?? environment.NO_PROXY ?? "",
        },
      },
    ),
  );
  const [output, , exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.runDrain),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0)
    return yield* Effect.fail({ _tag: "DevinQuotaWindowsRequestError" as const, exitCode });
  const footer = /\n(\d{3})\s*$/.exec(output);
  const status = footer ? Number(footer[1]) : 0;
  if (!footer || status < 200 || status > 599) {
    return yield* Effect.fail({ _tag: "DevinQuotaWindowsRequestError" as const, exitCode: -1 });
  }
  return HttpClientResponse.fromWeb(
    request,
    new Response(
      status === 204 || status === 205 || status === 304 ? null : output.slice(0, footer.index),
      { status, headers: { "content-type": "application/json" } },
    ),
  );
});

function quotaWindows(status: (typeof UserStatus.Type)["userStatus"]["planStatus"]) {
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, label, kind, remaining, reset, duration] of [
    [
      "daily",
      "Daily",
      "session",
      status.dailyQuotaRemainingPercent,
      status.dailyQuotaResetAtUnix,
      1440,
    ],
    [
      "weekly",
      "Weekly",
      "weekly",
      status.weeklyQuotaRemainingPercent,
      status.weeklyQuotaResetAtUnix,
      10080,
    ],
  ] as const) {
    const resetMs = reset === undefined ? Number.NaN : Number(reset) * 1000;
    const resetsAt =
      Number.isFinite(resetMs) && resetMs > 0 && resetMs <= 8_640_000_000_000_000
        ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
        : undefined;
    // Exhausted windows omit the zero-valued percentage but still report their reset clock.
    // A wholly absent window remains unknown; it must not become an invented daily allowance.
    if (remaining === undefined && resetsAt === undefined) continue;
    windows.push({
      id,
      label,
      kind,
      usedPercent: 100 - (remaining ?? 0),
      windowDurationMins: duration,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

/** Reads the account quota used by Devin's client; credentials remain in Devin's own store. */
export const readDevinAccount = Effect.fn("DevinUsageLimits.readAccount")(function* (
  environment: NodeJS.ProcessEnv,
  version: string,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = (reason: "unsupported" | "probeFailed", message: string) => ({
    usageLimits: {
      ...makeUnavailableUsageLimits({ checkedAt, reason, message }),
      provider: PROVIDER,
    } satisfies ServerProviderUsageLimits,
    email: undefined as string | undefined,
    plan: undefined as string | undefined,
  });
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
    const dataDirectory =
      platform === "win32"
        ? environment.APPDATA || path.join(home, "AppData", "Roaming")
        : environment.XDG_DATA_HOME || path.join(home, ".local", "share");
    const contents = yield* fs
      .readFileString(path.join(dataDirectory, "devin", "credentials.toml"))
      .pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        }),
      );
    const credentials = yield* Effect.fromResult(Toml.parse(contents)).pipe(
      Effect.flatMap(decodeCredentials),
    );
    const key = environment.WINDSURF_API_KEY?.trim() || credentials.windsurf_api_key?.trim();
    if (!key) return unavailable("unsupported", "Sign in with Devin to see subscription limits.");
    const server = yield* decodeServer(credentials.api_server_url ?? "https://server.codeium.com");
    if (
      server.protocol !== "https:" ||
      server.username ||
      server.password ||
      server.search ||
      server.hash
    ) {
      return unavailable(
        "probeFailed",
        "Devin quota requires its configured HTTPS account server.",
      );
    }
    let client = yield* HttpClient.HttpClient;
    const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? "";
    const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? "";
    if ((httpProxy || httpsProxy) && platform !== "win32") {
      // Electron's built-in fetch and the server's Undici can use different dispatchers.
      // Own this request's proxy explicitly; changing the global dispatcher affects other providers.
      const dispatcher = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new Undici.EnvHttpProxyAgent({
              httpProxy,
              httpsProxy,
              noProxy: environment.no_proxy ?? environment.NO_PROXY ?? "",
              allowH2: false,
              connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
              // ProxyAgent otherwise advertises h2 even when its outer agent disables it.
              clientFactory: (origin) =>
                new Undici.Pool(origin, {
                  allowH2: false,
                  connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
                }),
            }),
          catch: () => ({ _tag: "DevinQuotaProxyError" as const }),
        }),
        (agent) => Effect.promise(() => agent.destroy()),
      );
      client = yield* NodeHttpClient.makeUndici.pipe(
        Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
      );
    }
    // This is the client's internal Connect endpoint, rather than the public Devin task API.
    const payload = {
      metadata: {
        apiKey: key,
        ideName: "devin",
        ideVersion: version,
        extensionVersion: version,
        locale: "en",
      },
    };
    const request = HttpClientRequest.post(
      `${server.href.replace(/\/$/, "")}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    ).pipe(
      HttpClientRequest.setHeaders({ "Connect-Protocol-Version": "1" }),
      HttpClientRequest.bodyJsonUnsafe(payload),
    );
    const response =
      platform === "win32" && (httpProxy || httpsProxy)
        ? yield* readWindowsDevinStatus(request, yield* encodeJson(payload), environment)
        : yield* client
            .execute(request)
            .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    if (response.status === 401 || response.status === 403) {
      return unavailable(
        "probeFailed",
        "Devin could not authenticate the quota request. Check your Devin sign-in.",
      );
    }
    const { userStatus } = yield* decodeUserStatus(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    const windows = quotaWindows(userStatus.planStatus);
    const periodEnd = DateTime.make(userStatus.planStatus.planEnd ?? "");
    const plan = userStatus.planStatus.planInfo?.planName?.trim();
    if (windows.length === 0) {
      return unavailable(
        "unsupported",
        "This Devin account did not report daily or weekly subscription limits.",
      );
    }
    const crypto = yield* Digest.Digest;
    const fingerprint = yield* crypto.digest(
      Digest.sha256,
      new TextEncoder().encode(`devin\0${server.origin}\0${userStatus.userId}`),
    );
    return {
      email: userStatus.email?.trim() || undefined,
      plan: plan || undefined,
      usageLimits: {
        ...makeUsageLimits({ checkedAt, windows }),
        provider: PROVIDER,
        credentialFingerprint: Hex.encode(fingerprint),
        ...(Option.isSome(periodEnd) || plan
          ? {
              subscription: {
                ...(Option.isSome(periodEnd)
                  ? { periodEndsAt: DateTime.formatIso(periodEnd.value) }
                  : {}),
                ...(plan ? { plan } : {}),
              },
            }
          : {}),
      } satisfies ServerProviderUsageLimits,
    };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.succeed(
          unavailable(
            "probeFailed",
            "Devin quota request timed out. Check your proxy/network and refresh to retry.",
          ),
        ),
    }),
    Effect.catchTags({
      DevinQuotaWindowsRequestError: (error) =>
        Effect.succeed(
          unavailable(
            "probeFailed",
            error.exitCode === 28
              ? "Devin quota request timed out. Check your proxy/network and refresh to retry."
              : `Devin quota request failed (Windows network client exit ${error.exitCode}). Check your proxy/network and refresh.`,
          ),
        ),
    }),
    Effect.orElseSucceed(() =>
      unavailable(
        "probeFailed",
        "Could not read Devin subscription limits. Check your proxy/network and refresh; the Devin client API may have changed.",
      ),
    ),
  );
});
