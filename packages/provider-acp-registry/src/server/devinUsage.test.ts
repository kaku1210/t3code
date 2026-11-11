// @effect-diagnostics nodeBuiltinImport:off -- Builds a temporary native-history fixture.
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readDevinUsage } from "./devinUsage.ts";

describe("Devin subscription history", () => {
  it.effect(
    "reads per-request models and cache counters, deduplicates rendered copies and excludes API backends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "sessions.db");
        const db = new NodeSqlite.DatabaseSync(file);
        db.exec(
          "CREATE TABLE sessions(id TEXT, model TEXT, backend_type TEXT); CREATE TABLE message_nodes(row_id INTEGER, session_id TEXT, chat_message TEXT, created_at INTEGER)",
        );
        db.exec(
          "INSERT INTO sessions VALUES ('s','changed-model','windsurf'), ('api','direct-model','anthropic')",
        );
        const message = {
          role: "assistant",
          message_id: "m",
          metadata: {
            request_id: "request",
            generation_model: "claude-fable-5-2-medium",
            metrics: {
              input_tokens: 4,
              cache_read_tokens: 10,
              cache_creation_tokens: 20,
              output_tokens: 6,
            },
            created_at: "2026-11-11T01:20:06Z",
          },
        };
        const insert = db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?)");
        insert.run(1, "s", JSON.stringify(message), 1794360006);
        insert.run(2, "s", JSON.stringify(message), 1794360006);
        insert.run(3, "api", JSON.stringify(message), 1794360006);
        db.close();
        const result = yield* readDevinUsage(file, 1794350000000);
        expect(result.status).toBe("ok");
        expect(result.files?.[0]?.records).toHaveLength(1);
        expect(result.files?.[0]?.records[0]).toMatchObject({
          provider: "devin",
          model: "claude-fable-5-2-medium",
          rateModel: "claude-fable-5-2",
          totals: {
            uncachedInputTokens: 4,
            cachedInputTokens: 10,
            cacheCreationTokens: 20,
            outputTokens: 6,
          },
        });
        expect((yield* readDevinUsage(file, 1794370000000)).files?.[0]?.records).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
