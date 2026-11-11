// @effect-diagnostics nodeBuiltinImport:off -- Devin owns this SQLite file; always open it read-only.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { UsageReadError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { AcpRegistrySettings } from "../settings.ts";

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Read only the request accounting fields, never conversation text or credentials. */
export const readDevinUsage = Effect.fn("DevinUsage.read")(function* (
  file: string,
  sinceMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  if (
    !(yield* fs.exists(file).pipe(
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Devin history could not be located.",
            cause,
          }),
      ),
    ))
  )
    return { dir: file, files: null, status: "missing" as const };
  return yield* Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        const rows = db
          .prepare(`SELECT n.row_id, n.session_id, n.created_at,
        json_extract(n.chat_message,'$.message_id') message_id,
        json_extract(n.chat_message,'$.metadata.request_id') request_id,
        json_extract(n.chat_message,'$.metadata.generation_model') model,
        json_extract(n.chat_message,'$.metadata.created_at') timestamp,
        json_extract(n.chat_message,'$.metadata.metrics.input_tokens') input_tokens,
        json_extract(n.chat_message,'$.metadata.metrics.cache_read_tokens') cache_read_tokens,
        json_extract(n.chat_message,'$.metadata.metrics.cache_creation_tokens') cache_creation_tokens,
        json_extract(n.chat_message,'$.metadata.metrics.output_tokens') output_tokens
        FROM message_nodes n JOIN sessions s ON s.id=n.session_id
        WHERE s.backend_type='windsurf' AND n.created_at>=?
        AND json_extract(n.chat_message,'$.role')='assistant'
        AND json_extract(n.chat_message,'$.metadata.metrics') IS NOT NULL
        ORDER BY n.created_at,n.row_id`)
          .all(Math.floor(sinceMs / 1000));
        const records = new Map<string, UsageRecord>();
        let invalid = 0;
        for (const row of rows) {
          const metrics = row;
          const names = [
            "input_tokens",
            "cache_read_tokens",
            "cache_creation_tokens",
            "output_tokens",
          ] as const;
          if (
            typeof row.model !== "string" ||
            !row.model ||
            names.some(
              (key) =>
                metrics[key] != null &&
                (!Number.isSafeInteger(metrics[key]) || Number(metrics[key]) < 0),
            )
          ) {
            invalid++;
            continue;
          }
          const totals = {
            uncachedInputTokens: Number(metrics.input_tokens ?? 0),
            cachedInputTokens: Number(metrics.cache_read_tokens ?? 0),
            cacheCreationTokens: Number(metrics.cache_creation_tokens ?? 0),
            outputTokens: Number(metrics.output_tokens ?? 0),
            reasoningTokens: 0,
          };
          if (totalTokens(totals) === 0) continue;
          const timestampMs =
            typeof row.timestamp === "string"
              ? Date.parse(row.timestamp)
              : Number(row.created_at) * 1000;
          if (!Number.isFinite(timestampMs)) {
            invalid++;
            continue;
          }
          if (timestampMs < sinceMs) continue;
          const key = encodeIdentity([
            "devin",
            String(row.session_id),
            String(row.request_id ?? row.message_id ?? row.row_id),
            row.model,
          ]);
          records.set(key, {
            provider: "devin",
            timestampMs,
            model: row.model,
            rateModel: row.model.replace(/-(?:none|minimal|low|medium|high|xhigh|max)$/, ""),
            sessionId: String(row.session_id),
            totals,
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: key,
          });
        }
        return {
          dir: file,
          files: [{ path: file, records: [...records.values()] }],
          status: invalid > 0 ? ("partial" as const) : ("ok" as const),
          ...(invalid > 0
            ? { message: `${invalid} Devin usage records lack valid accounting fields.` }
            : {}),
        };
      } finally {
        db.close();
      }
    },
    catch: (cause) =>
      new UsageReadError({
        reason: "scanFailed",
        detail: "Devin history could not be read.",
        cause,
      }),
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        dir: file,
        files: null,
        status: "failed" as const,
        message: "Devin history could not be read.",
      }),
    ),
  );
});

export const devinUsageReader: ProviderUsageReader<
  AcpRegistrySettings,
  FileSystem.FileSystem | Path.Path
> = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("DevinUsage.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const files = new Set<string>();
    for (const instance of instances) {
      if (instance.config?.source !== "registry" || instance.config.agentId !== "devin") continue;
      const env = instance.environment;
      const data =
        platform === "win32"
          ? env.APPDATA || path.join(home, "AppData", "Roaming")
          : platform === "darwin"
            ? path.join(env.HOME || home, "Library", "Application Support")
            : env.XDG_DATA_HOME || path.join(env.HOME || home, ".local", "share");
      files.add(path.join(data, "devin", "cli", "sessions.db"));
    }
    return yield* Effect.forEach(files, (file) => readDevinUsage(file, windowStartMs));
  }),
};
