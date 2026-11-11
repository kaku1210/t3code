// @effect-diagnostics nodeBuiltinImport:off -- The updater must outlive Electron's Effect scope and its installation directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
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

/** Release process handles only after the coordinator has validated the package and captured us. */
export const runWindowsLocalUpdate = Effect.fn("desktop.windows.localUpdate")(function (
  script: string,
  requestPath: string,
  validateOnly: boolean,
) {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const invocation = `& '${script.replaceAll("'", "''")}' -RequestPath '${requestPath.replaceAll("'", "''")}'${validateOnly ? " -ValidateOnly" : ""}`;
        // Keep paths out of CMD parsing, including Unicode, percent signs and apostrophes.
        const encodedInvocation = Buffer.from(invocation, "utf16le").toString("base64");
        const powershellArguments = [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedInvocation,
        ];
        const child = NodeChildProcess.spawn(
          validateOnly ? "powershell.exe" : "cmd.exe",
          validateOnly
            ? powershellArguments
            : ["/d", "/s", "/c", "powershell.exe", ...powershellArguments],
          // PowerShell needs its own hidden console; detaching CMD lets it survive Electron's exit.
          {
            // An inherited installation-directory handle prevents its backup rename on Windows.
            cwd: NodePath.dirname(script),
            windowsHide: true,
            detached: !validateOnly,
            windowsVerbatimArguments: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        let errorOutput = "";
        let settled = false;
        let watcher: NodeFS.FSWatcher | undefined;
        const abort = () => {
          try {
            NodeFS.writeFileSync(`${requestPath}.cancelled`, "cancelled");
            child.kill();
            finish(new Error("本地更新已取消。"));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        function finish(error?: Error) {
          if (settled) return;
          settled = true;
          watcher?.close();
          signal.removeEventListener("abort", abort);
          if (!error && !validateOnly) {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
          }
          if (error) reject(error);
          else resolve();
        }
        function inspectHandoff() {
          if (settled) return;
          try {
            if (NodeFS.existsSync(`${requestPath}.error`)) {
              finish(new Error(NodeFS.readFileSync(`${requestPath}.error`, "utf8")));
            } else if (NodeFS.existsSync(`${requestPath}.ready`)) {
              finish();
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
        signal.addEventListener("abort", abort, { once: true });
        child.on("error", finish);
        child.stderr.on("data", (data: Buffer) => {
          errorOutput = (errorOutput + data.toString()).slice(-4000);
        });
        child.stdout.on("data", (data: Buffer) => {
          output = (output + data.toString()).slice(-4000);
        });
        child.on("close", (code) => {
          if (validateOnly || code !== 0)
            finish(
              code === 0
                ? undefined
                : new Error(errorOutput || output || `更新协调器未完成接管就退出 (${code})。`),
            );
        });
        if (!validateOnly) {
          try {
            // The launcher can exit before its independent PowerShell child; stdout is not a handoff signal.
            watcher = NodeFS.watch(NodePath.dirname(requestPath), inspectHandoff);
            watcher.on("error", finish);
            inspectHandoff();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
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
