// @effect-diagnostics nodeBuiltinImport:off - Exercises a local CONNECT proxy without contacting Devin.
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readDevinAccount } from "./devinUsageLimits.ts";

const response = {
  userStatus: {
    userId: "account-one",
    email: "person@example.test",
    planStatus: {
      planInfo: { planName: "Pro" },
      dailyQuotaRemainingPercent: 98,
      weeklyQuotaRemainingPercent: 63,
      dailyQuotaResetAtUnix: "1794211200",
      weeklyQuotaResetAtUnix: "1794729600",
    },
  },
};

function readAccount(options: {
  body?: unknown;
  credentials?: string;
  status?: number;
  environment?: NodeJS.ProcessEnv;
  inspect?: (request: HttpClientRequest.HttpClientRequest) => void;
  platform?: NodeJS.Platform;
}) {
  return readDevinAccount({ APPDATA: "C:/profile", ...options.environment }, "3000.12.28").pipe(
    Effect.provideService(HostProcess.Platform, options.platform ?? "win32"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readFileString: () =>
          Effect.succeed(
            options.credentials ??
              'windsurf_api_key = "test-secret"\napi_server_url = "https://server.codeium.com"',
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        options.inspect?.(request);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(options.body ?? response, { status: options.status ?? 200 }),
          ),
        );
      }),
    ),
    Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
}

describe("Devin account limits", () => {
  it.effect("reports the subscription period independently of daily and weekly quota resets", () =>
    Effect.gen(function* () {
      const account = yield* readAccount({
        body: {
          userStatus: {
            ...response.userStatus,
            planStatus: {
              ...response.userStatus.planStatus,
              planEnd: "2026-11-12T06:12:15Z",
            },
          },
        },
      });
      expect(account.usageLimits).toMatchObject({
        subscription: { periodEndsAt: "2026-11-12T06:12:15.000Z", plan: "Pro" },
      });
      const unknown = yield* readAccount({});
      expect(unknown.usageLimits.subscription?.periodEndsAt).toBeUndefined();
      expect(unknown.usageLimits.subscription?.plan).toBe("Pro");
      const invalid = yield* readAccount({
        body: {
          userStatus: {
            ...response.userStatus,
            planStatus: {
              ...response.userStatus.planStatus,
              planEnd: "not-a-date",
            },
          },
        },
      });
      expect(invalid.usageLimits.windows).toHaveLength(2);
      expect(invalid.usageLimits.subscription?.periodEndsAt).toBeUndefined();
    }),
  );
  it.live("uses the configured proxy without relying on the host's built-in fetch", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const proxy = yield* Effect.acquireDisposable(
        Effect.sync(() =>
          NodeNet.createServer((socket) => {
            socket.once("data", (chunk) => {
              requests.push(chunk.toString());
              socket.end(
                "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
              );
            });
          }),
        ),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
      );
      const address = proxy.address();
      if (address === null || typeof address === "string")
        throw new Error("Proxy did not bind TCP");
      const platform = yield* HostProcess.Platform;
      const account = yield* readAccount({
        platform,
        environment: { HTTPS_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "" },
      });
      expect(requests.join("")).toMatch(/^CONNECT server\.codeium\.com:443 HTTP\/1\.1\r\n/);
      expect(account.usageLimits.windows).toEqual([]);
      expect(account.usageLimits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.scoped),
  );

  it.effect("reads independent quota windows, resets and a non-secret account identity", () =>
    Effect.gen(function* () {
      const account = yield* readAccount({
        inspect: (request) => {
          expect(request.url).toBe(
            "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
          );
          expect(request.method).toBe("POST");
          expect(request.headers["connect-protocol-version"]).toBe("1");
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag === "Uint8Array") {
            expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject({
              metadata: { apiKey: "test-secret", extensionVersion: "3000.12.28", locale: "en" },
            });
          }
        },
      });
      expect(account.email).toBe("person@example.test");
      expect(account.plan).toBe("Pro");
      expect(account.usageLimits.provider).toEqual({ id: "devin", label: "Devin" });
      expect(account.usageLimits.windows).toMatchObject([
        { id: "daily", label: "Daily", usedPercent: 2, resetsAt: "2026-11-09T08:00:00.000Z" },
        { id: "weekly", label: "Weekly", usedPercent: 37, resetsAt: "2026-11-15T08:00:00.000Z" },
      ]);
      expect(account.usageLimits.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(account)).not.toContain("test-secret");
      const duplicate = yield* readAccount({ credentials: 'windsurf_api_key = "different-login"' });
      expect(duplicate.usageLimits.credentialFingerprint).toBe(
        account.usageLimits.credentialFingerprint,
      );
    }),
  );

  it.effect(
    "keeps exhausted windows with reset clocks while omitting wholly unreported allowances",
    () =>
      Effect.gen(function* () {
        const account = yield* readAccount({
          body: {
            userStatus: {
              userId: "account-one",
              planStatus: { weeklyQuotaRemainingPercent: 0 },
            },
          },
        });
        expect(account.usageLimits.windows).toEqual([
          {
            id: "weekly",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 100,
            windowDurationMins: 10080,
          },
        ]);
        const exhausted = yield* readAccount({
          body: {
            userStatus: {
              userId: "account-one",
              planStatus: {
                dailyQuotaResetAtUnix: "1794384000",
                weeklyQuotaRemainingPercent: 32,
                weeklyQuotaResetAtUnix: "1794729600",
              },
            },
          },
        });
        expect(exhausted.usageLimits.windows).toMatchObject([
          { id: "daily", usedPercent: 100, resetsAt: "2026-11-11T08:00:00.000Z" },
          { id: "weekly", usedPercent: 68, resetsAt: "2026-11-15T08:00:00.000Z" },
        ]);
        const noClock = yield* readAccount({
          body: {
            userStatus: {
              userId: "account-one",
              planStatus: { dailyQuotaResetAtUnix: "0", weeklyQuotaRemainingPercent: 32 },
            },
          },
        });
        expect(noClock.usageLimits.windows.map((window) => window.id)).toEqual(["weekly"]);
      }),
  );

  it.effect(
    "uses an explicit key and the configured credential server without reading another login",
    () =>
      readAccount({
        environment: { WINDSURF_API_KEY: "explicit-key" },
        credentials: 'windsurf_api_key = "old-key"\napi_server_url = "https://devin.example.test"',
        inspect: (request) => {
          expect(request.url).toMatch(/^https:\/\/devin\.example\.test\//);
          if (request.body._tag === "Uint8Array") {
            expect(JSON.parse(new TextDecoder().decode(request.body.body)).metadata.apiKey).toBe(
              "explicit-key",
            );
          }
        },
      }).pipe(Effect.asVoid),
  );

  it.effect("reports missing credentials, invalid data and refusals without inventing quota", () =>
    Effect.gen(function* () {
      const missing = yield* readAccount({ credentials: "" });
      expect(missing.usageLimits.unavailable?.reason).toBe("unsupported");
      for (const options of [
        { credentials: 'windsurf_api_key = "test-secret"\napi_server_url = "http://unsafe.test"' },
        { credentials: "invalid TOML [" },
        { status: 401 },
        { status: 302 },
        { body: { userStatus: { userId: "one", planStatus: { dailyQuotaRemainingPercent: -1 } } } },
        { body: {} },
      ]) {
        const account = yield* readAccount(options);
        expect(account.usageLimits.windows).toEqual([]);
        expect(account.usageLimits.unavailable?.reason).toBe("probeFailed");
        expect(JSON.stringify(account)).not.toContain("test-secret");
      }
      const unreported = yield* readAccount({
        body: { userStatus: { userId: "one", planStatus: {} } },
      });
      expect(unreported.usageLimits.windows).toEqual([]);
      expect(unreported.usageLimits.unavailable?.reason).toBe("unsupported");
    }),
  );
});
