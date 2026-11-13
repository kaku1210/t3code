import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe } from "vite-plus/test";
import { LocalUpdateRequest, startLocalUpdateCoordinator } from "./WindowsLocalUpdate.ts";

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(LocalUpdateRequest));
const coordinator = new URL("../../resources/local-update.ps1", import.meta.url);

const runCoordinator = Effect.fn("test.runCoordinator")(function* (requestPath: string) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        yield* path.fromFileUrl(coordinator),
        "-RequestPath",
        requestPath,
        "-Quiet",
      ],
      { stdin: "ignore" },
    ),
  );
  return Number(yield* handle.exitCode);
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- Select the native Windows tests during collection, before an Effect runtime exists.
describe.runIf(process.platform === "win32")("Windows local update", () => {
  it.live("installs into the current folder and verifies the installed version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-update-" });
      const installDirectory = path.join(directory, "T3 Code's Plus");
      yield* fs.makeDirectory(installDirectory);
      const installer = path.join(directory, "setup.cmd");
      const received = path.join(directory, "arguments.txt");
      const fail = path.join(directory, "fail");
      yield* fs.writeFileString(
        installer,
        `@echo off\r\n> "%~dp0arguments.txt" echo %*\r\nif exist "%~dp0fail" exit /b 2\r\n`,
      );
      // PowerShell's own executable, with its version resource, stands in for the installed client.
      const [executable = "", installedVersion = ""] = yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handle = yield* spawner.spawn(
            ChildProcess.make("powershell.exe", [
              "-NoProfile",
              "-Command",
              "$f = (Get-Process -Id $PID).Path; $f; (Get-Item -LiteralPath $f).VersionInfo.FileVersion",
            ]),
          );
          return (yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString))
            .trim()
            .split(/\r?\n/);
        }),
      );
      const request = (targetVersion: string) =>
        Effect.gen(function* () {
          const requestPath = path.join(directory, "request.json");
          yield* fs.writeFileString(
            requestPath,
            yield* encodeRequest({ installer, installDirectory, executable, targetVersion }),
          );
          return requestPath;
        });

      assert.equal(yield* runCoordinator(yield* request(installedVersion)), 0);
      assert.equal(
        (yield* fs.readFileString(received)).trim(),
        `--updated /S /D=${installDirectory}`,
      );

      assert.equal(yield* runCoordinator(yield* request("0.0.0-not-installed")), 1);
      assert.include(yield* fs.readFileString(path.join(directory, "update.log")), "0.0.0");

      yield* fs.writeFileString(fail, "");
      assert.equal(yield* runCoordinator(yield* request(installedVersion)), 1);
      assert.include(yield* fs.readFileString(path.join(directory, "update.log")), "退出代码 2");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("starts the coordinator on its own, from paths with spaces and quotes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-update-launch-" });
      const directory = path.join(parent, "更新 & it's");
      yield* fs.makeDirectory(directory);
      const script = path.join(directory, "coordinator.ps1");
      const requestPath = path.join(directory, "request.json");
      yield* fs.writeFileString(
        script,
        "﻿param([string]$RequestPath)\nSet-Content -LiteralPath ($RequestPath + '.started') -Value $PID\n",
      );
      const started = yield* fs.watch(directory).pipe(
        Stream.filter((event) => path.basename(event.path) === "request.json.started"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* startLocalUpdateCoordinator({ script, requestPath });
      yield* Fiber.join(started);
      assert.isTrue(yield* fs.exists(`${requestPath}.started`));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
