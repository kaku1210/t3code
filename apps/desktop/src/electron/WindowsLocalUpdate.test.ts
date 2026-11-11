import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";
import { runWindowsLocalUpdate } from "./WindowsLocalUpdate.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Select the native Windows test during collection, before its Effect runtime exists.
describe.runIf(process.platform === "win32")("Windows local update", () => {
  it.live("executes the coordinator and waits for its readiness before releasing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-handoff-test-" });
      const paths = `${directory}/更新 & %coordinator's`;
      yield* fs.makeDirectory(paths);
      const script = path.join(
        path.dirname(directory),
        `${path.basename(directory)}-更新 & %coordinator's.ps1`,
      );
      yield* Effect.addFinalizer(() => fs.remove(script).pipe(Effect.orDie));
      const scriptDirectory = path.dirname(script).replaceAll("\\", "/");
      const marker = `${paths}/executed.txt`;
      yield* fs.writeFileString(
        script,
        [
          "param([string]$RequestPath, [switch]$ValidateOnly)",
          "[IO.File]::WriteAllText($RequestPath, [Environment]::CurrentDirectory)",
          "if (-not $ValidateOnly) {",
          "  [IO.File]::WriteAllText($RequestPath + '.ready.tmp', 'ready')",
          "  [IO.File]::Move($RequestPath + '.ready.tmp', $RequestPath + '.ready')",
          "}",
        ].join("\n"),
      );
      yield* runWindowsLocalUpdate(script, marker, true);
      assert.equal(
        (yield* fs.readFileString(marker)).trim().replaceAll("\\", "/"),
        scriptDirectory,
      );
      yield* fs.remove(marker);
      yield* runWindowsLocalUpdate(script, marker, false);
      assert.equal(
        (yield* fs.readFileString(marker)).trim().replaceAll("\\", "/"),
        scriptDirectory,
      );
      yield* fs.remove(`${marker}.ready`);
      yield* fs.writeFileString(
        script,
        [
          "param([string]$RequestPath)",
          "[IO.File]::WriteAllText($RequestPath + '.error.tmp', 'Package validation failed.')",
          "[IO.File]::Move($RequestPath + '.error.tmp', $RequestPath + '.error')",
          "exit 1",
        ].join("\n"),
      );
      const error = yield* runWindowsLocalUpdate(script, marker, false).pipe(Effect.flip);
      assert.equal(error.detail, "Package validation failed.");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
