// @effect-diagnostics nodeBuiltinImport:off -- The updater must outlive Electron's Effect scope and its installation directory.
import * as NodeChildProcess from "node:child_process";
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

/** Detach only after the external coordinator has validated the package and captured our process. */
export const runWindowsLocalUpdate = Effect.fn("desktop.windows.localUpdate")(function (
  script: string,
  requestPath: string,
  validateOnly: boolean,
) {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-RequestPath",
            requestPath,
            ...(validateOnly ? ["-ValidateOnly"] : []),
          ],
          { windowsHide: true, detached: !validateOnly, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        let errorOutput = "";
        let settled = false;
        const abort = () => {
          child.kill();
          finish(new Error("本地更新已取消。"));
        };
        function finish(error?: Error) {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        }
        signal.addEventListener("abort", abort, { once: true });
        child.on("error", finish);
        child.stderr.on("data", (data: Buffer) => {
          errorOutput = (errorOutput + data.toString()).slice(-4000);
        });
        child.stdout.on("data", (data: Buffer) => {
          output += data.toString();
          if (!validateOnly && output.includes("T3_LOCAL_UPDATE_READY")) {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish();
          }
        });
        child.on("exit", (code) =>
          finish(
            validateOnly && code === 0
              ? undefined
              : new Error(errorOutput || `更新协调器退出 (${code})。`),
          ),
        );
      }),
    catch: (error) =>
      new WindowsLocalUpdateError({
        detail: error instanceof Error ? error.message : String(error),
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(new WindowsLocalUpdateError({ detail: "本地更新预检超时；客户端保持打开。" })),
    }),
  );
});
