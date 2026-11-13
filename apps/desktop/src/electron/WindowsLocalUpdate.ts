// @effect-diagnostics nodeBuiltinImport:off -- The launcher runs once from a click; Effect owns only its outcome.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WindowsLocalUpdateError extends Schema.TaggedError<WindowsLocalUpdateError>()(
  "WindowsLocalUpdateError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** Read by `resources/local-update.ps1`. */
export const LocalUpdateRequest = Schema.Struct({
  installer: Schema.String,
  installDirectory: Schema.String,
  executable: Schema.String,
  targetVersion: Schema.String,
});

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The client runs in a job object that kills its children when it exits, detached or not.
 * Win32_Process.Create starts the coordinator outside that job, in the same session, hidden.
 */
function coordinatorLaunchScript(input: {
  readonly script: string;
  readonly requestPath: string;
}): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$command = '"' + $powershell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ${literal(input.script)} + '" -RequestPath "' + ${literal(input.requestPath)} + '"'`,
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $env:TEMP; ProcessStartupInformation = $startup }",
    "if ($result.ReturnValue -ne 0) { [Console]::Error.Write('Win32_Process.Create ' + $result.ReturnValue); exit 1 }",
  ].join("\n");
}

/** Resolves once the coordinator is running on its own; the caller then quits. */
export const startLocalUpdateCoordinator = Effect.fn("desktop.windows.startLocalUpdateCoordinator")(
  function (input: { readonly script: string; readonly requestPath: string }) {
    if ([input.script, input.requestPath].some((value) => /["\r\n]/.test(value)))
      return Effect.fail(new WindowsLocalUpdateError({ detail: "更新临时目录的路径无效。" }));
    return Effect.callback<void, WindowsLocalUpdateError>((resume) => {
      const encoded = Buffer.from(coordinatorLaunchScript(input), "utf16le").toString("base64");
      const child = NodeChildProcess.spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { cwd: NodeOS.tmpdir(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let errorOutput = "";
      child.stderr.on("data", (data: Buffer) => {
        errorOutput = (errorOutput + data.toString()).slice(-2000);
      });
      const fail = (detail: string) =>
        resume(Effect.fail(new WindowsLocalUpdateError({ detail: `无法启动本地更新：${detail}` })));
      child.once("error", (error) => fail(error.message));
      child.once("close", (code) =>
        code === 0 ? resume(Effect.void) : fail(errorOutput.trim() || `退出代码 ${code}`),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new WindowsLocalUpdateError({ detail: "启动本地更新超时，客户端保持打开。" }),
          ),
      }),
    );
  },
);
