import { ModelSelection, ProviderSetupError, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as RcRef from "effect/RcRef";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type AcpError, AcpRequestError } from "effect-acp/errors";

import {
  antigravityThinkingConfig,
  applyAntigravityAcpModelSelection,
} from "../provider/acp/AntigravityAcpSupport.ts";
import { removeAntigravitySessionFiles } from "../provider/acp/AntigravitySessionFiles.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../provider/antigravityAuthSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";

const ANTIGRAVITY_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
const isTextGenerationError = Schema.is(TextGenerationError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const Configuration = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Configuration));
const decodeConfigurationObject = Schema.decodeUnknownEffect(Configuration);
const encodeResponseSchema = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));

type AntigravityTextRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "start"
  | "createSession"
  | "setMode"
  | "getConfigOptions"
  | "getEvents"
  | "setModel"
  | "setConfigOption"
  | "prompt"
  | "cancel"
  | "handleSessionUpdate"
  | "handleRequestPermission"
  | "handleElicitation"
  | "handleReadTextFile"
  | "handleWriteTextFile"
  | "handleCreateTerminal"
  | "handleTerminalOutput"
  | "handleTerminalWaitForExit"
  | "handleTerminalKill"
  | "handleTerminalRelease"
  | "handleUnknownExtRequest"
>;

export interface AntigravityTextGenerationOptions {
  readonly profileDirectory: string;
  readonly defaultModel?: Effect.Effect<string | undefined>;
  readonly makeRuntime: (
    cwd: string,
  ) => Effect.Effect<AntigravityTextRuntime, AcpError | ProviderSetupError, Scope.Scope>;
  readonly withProcess: <A, E, R>(
    stop: Effect.Effect<void>,
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
}

/** Global hooks and MCP servers can run before a helper can deny a tool request. */
export const isAntigravityTextGenerationAvailable = Effect.fn(
  "isAntigravityTextGenerationAvailable",
)(function* (profileDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of ["hooks.json", "mcp_config.json"]) {
    const configurationPath = path.join(profileDirectory, "config", name);
    if (!(yield* fs.exists(configurationPath))) {
      continue;
    }
    const info = yield* fs.stat(configurationPath);
    if (info.type !== "File" || info.size > 64_000n) {
      return false;
    }
    const empty = yield* fs.readFileString(configurationPath).pipe(
      Effect.flatMap(decodeConfiguration),
      Effect.flatMap((configuration) =>
        decodeConfigurationObject(
          configuration[name === "hooks.json" ? "hooks" : "mcpServers"] ?? configuration,
        ),
      ),
      Effect.map((configuration) => Object.keys(configuration).length === 0),
      Effect.orElseSucceed(() => false),
    );
    if (!empty) return false;
  }
  return true;
});

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  options: AntigravityTextGenerationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hasOnlyRuntimeDirectories = Effect.fn(
    "AntigravityTextGeneration.hasOnlyRuntimeDirectories",
  )(function* (cwd: string) {
    const root = yield* fs.realPath(cwd);
    // ACP creates these empty skill directories before the first prompt.
    const allowed = new Set([
      path.join(root, ".agents"),
      path.join(root, ".agents", "skills"),
      path.join(root, ".gemini"),
      path.join(root, ".gemini", "skills"),
    ]);
    const directories = [root];
    for (const directory of directories) {
      for (const name of yield* fs.readDirectory(directory)) {
        const entry = path.join(directory, name);
        if (
          !allowed.has(entry) ||
          (yield* fs.realPath(entry)) !== entry ||
          (yield* fs.stat(entry)).type !== "Directory"
        ) {
          return false;
        }
        directories.push(entry);
      }
    }
    return true;
  });

  const available = isAntigravityTextGenerationAvailable(options.profileDirectory).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  // The provider instance owns this resource; a request only borrows it.
  const acquireHelper = Effect.fn("AntigravityTextGeneration.acquireHelper")(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    return yield* options
      .withProcess(
        Scope.close(scope, Exit.void),
        Effect.gen(function* () {
          const cwd = yield* Effect.acquireRelease(
            fs.makeTempDirectory({ prefix: "t3-antigravity-text-" }),
            (directory) =>
              fs.remove(directory, { recursive: true }).pipe(
                Effect.retry({
                  times: 10,
                  schedule: Schedule.spaced("100 millis"),
                  while: (error) =>
                    error.reason._tag === "Busy" || error.reason._tag === "PermissionDenied",
                }),
                Effect.orDie,
              ),
          );
          const sessionIds: Array<string> = [];
          yield* Effect.addFinalizer(() =>
            Effect.forEach(
              sessionIds,
              (sessionId) =>
                removeAntigravitySessionFiles({
                  profileDirectory: options.profileDirectory,
                  sessionId,
                  cwd,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                ),
              { discard: true },
            ),
          );
          let closed = false;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          const runtime = yield* options.makeRuntime(cwd);
          yield* runtime.getEvents().pipe(
            Stream.runForEach((event) =>
              event._tag === "EventStreamBarrier"
                ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          let active:
            | {
                readonly operation: TextGenerationOperations.Operation;
                readonly rejected: Deferred.Deferred<never, TextGenerationError>;
                sessionId: string | undefined;
                output: string;
              }
            | undefined;
          const reject = (detail: string) =>
            Effect.suspend(() =>
              active
                ? Deferred.fail(
                    active.rejected,
                    new TextGenerationError({ operation: active.operation, detail }),
                  ).pipe(Effect.asVoid)
                : Effect.void,
            );
          const rejectToolRequest = () =>
            reject("Antigravity text generation requested a tool or user input.").pipe(
              Effect.andThen(
                Effect.fail(
                  new AcpRequestError({
                    code: -32601,
                    errorMessage: "Tools and user input are disabled for text generation.",
                  }),
                ),
              ),
            );
          yield* runtime.handleRequestPermission(() =>
            reject("Antigravity text generation requested a tool permission or user input.").pipe(
              Effect.as({ outcome: { outcome: "cancelled" as const } }),
            ),
          );
          yield* runtime.handleElicitation(() =>
            reject("Antigravity text generation requested user input.").pipe(
              Effect.as({ action: "decline" as const }),
            ),
          );
          yield* runtime.handleReadTextFile(rejectToolRequest);
          yield* runtime.handleWriteTextFile(rejectToolRequest);
          yield* runtime.handleCreateTerminal(rejectToolRequest);
          yield* runtime.handleTerminalOutput(rejectToolRequest);
          yield* runtime.handleTerminalWaitForExit(rejectToolRequest);
          yield* runtime.handleTerminalKill(rejectToolRequest);
          yield* runtime.handleTerminalRelease(rejectToolRequest);
          yield* runtime.handleUnknownExtRequest(rejectToolRequest);
          // ACP adds notification handlers rather than replacing them. Register once per process.
          yield* runtime.handleSessionUpdate((notification) =>
            Effect.suspend(() => {
              const current = active;
              if (!current) return Effect.void;
              const update = notification.update;
              if (
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update"
              ) {
                return reject("Antigravity attempted tool work during text generation.");
              }
              if (
                notification.sessionId !== current.sessionId ||
                update.sessionUpdate !== "agent_message_chunk" ||
                update.content.type !== "text"
              ) {
                return Effect.void;
              }
              if (current.output.length + update.content.text.length > MAX_OUTPUT_CHARS) {
                return reject("Antigravity text generation exceeded the output limit.");
              }
              current.output += update.content.text;
              return Effect.void;
            }),
          );

          const run = Effect.fn("AntigravityTextGeneration.runHelper")(
            function* (input: TextGenerationOperations.Request<Schema.Top>) {
              const rejected = yield* Deferred.make<never, TextGenerationError>();
              const current = {
                operation: input.operation,
                rejected,
                sessionId: undefined as string | undefined,
                output: "",
              };
              active = current;
              const output = yield* Effect.gen(function* () {
                // Empty native sessions keep project excerpts and response schemas isolated.
                const started = yield* sessionIds.length === 0
                  ? runtime.start()
                  : runtime.createSession();
                current.sessionId = started.sessionId;
                if (!isNativeSessionId(started.sessionId)) {
                  return yield* new TextGenerationError({
                    operation: input.operation,
                    detail: "Antigravity returned an invalid text helper session ID.",
                  });
                }
                sessionIds.push(started.sessionId);
                yield* runtime.setMode("default");
                yield* applyAntigravityAcpModelSelection({
                  runtime,
                  model: input.modelSelection.model,
                  defaultModel: yield* options.defaultModel ?? Effect.undefined,
                  mapError: (cause) =>
                    new TextGenerationError({
                      operation: input.operation,
                      detail: "Could not select the Antigravity model for text generation.",
                      cause,
                    }),
                });
                const thinking = antigravityThinkingConfig(yield* runtime.getConfigOptions);
                const selection = input.modelSelection.options?.find(
                  (option) => option.id === thinking?.id,
                );
                if (selection) {
                  yield* runtime.setConfigOption(selection.id, selection.value).pipe(
                    Effect.mapError(
                      (cause) =>
                        new TextGenerationError({
                          operation: input.operation,
                          detail:
                            "Could not apply the Antigravity thinking level for text generation.",
                          cause,
                        }),
                    ),
                  );
                }
                const prompt = runtime.prompt({
                  prompt: [
                    {
                      type: "text",
                      text: [
                        "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
                        "Return only a JSON object matching this response schema:",
                        yield* encodeResponseSchema(toJsonSchemaObject(input.outputSchema)),
                        "",
                        input.prompt,
                      ].join("\n"),
                    },
                  ],
                });
                const result = yield* input.operation === "generatePromptSuggestion"
                  ? prompt.pipe(
                      Effect.timeoutOrElse({
                        duration: "60 seconds",
                        orElse: () =>
                          Effect.fail(
                            new TextGenerationError({
                              operation: input.operation,
                              detail:
                                "Antigravity suggestion generation timed out after 60 seconds.",
                            }),
                          ),
                      }),
                    )
                  : prompt;
                if (yield* Deferred.isDone(rejected)) return yield* Deferred.await(rejected);
                if (result.stopReason === "cancelled") {
                  return yield* new TextGenerationError({
                    operation: input.operation,
                    detail: "Antigravity text generation was cancelled.",
                  });
                }
                return current.output.trim();
              }).pipe(
                Effect.onInterrupt(() =>
                  runtime.cancel.pipe(Effect.timeoutOption(2_000), Effect.ignore),
                ),
                Effect.raceFirst(Deferred.await(rejected)),
              );
              if (!(yield* hasOnlyRuntimeDirectories(cwd))) {
                return yield* new TextGenerationError({
                  operation: input.operation,
                  detail: "Antigravity wrote files during text generation.",
                });
              }
              if (!output) {
                return yield* new TextGenerationError({
                  operation: input.operation,
                  detail: "Antigravity returned empty text generation output.",
                });
              }
              return output;
            },
            Effect.ensuring(
              Effect.sync(() => {
                active = undefined;
              }),
            ),
          );
          return {
            run: (input: TextGenerationOperations.Request<Schema.Top>) =>
              Effect.acquireUseRelease(
                Effect.forkIn(run(input), scope),
                Fiber.join,
                Fiber.interrupt,
              ),
            sessionIds,
            isClosed: () => closed,
          };
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, scope));
  });

  const worker = yield* RcRef.make({ acquire: acquireHelper(), idleTimeToLive: "5 minutes" });
  const workerLock = yield* Semaphore.make(1);
  let workerSelection: string | undefined;
  const runAntigravityJson = Effect.fn("AntigravityTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) {
      if (!(yield* available)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            "Antigravity text generation is unavailable for profiles with global hooks or MCP configuration. Select another system model.",
        });
      }
      const shared = input.operation === "generatePromptSuggestion";
      if (shared) {
        const selection = yield* encodeSelection(input.modelSelection);
        if (workerSelection !== selection) {
          yield* RcRef.invalidate(worker);
          workerSelection = selection;
        }
      }
      let helper = yield* shared ? RcRef.get(worker) : acquireHelper();
      // Sign-out can close an idle process before the RcRef's idle timer fires.
      if (shared && helper.isClosed()) {
        yield* RcRef.invalidate(worker);
        helper = yield* RcRef.get(worker);
      }
      const output = yield* helper.run(input);
      const result = yield* TextGenerationOperations.decodeJsonReply(input, "Antigravity", output);
      // This ACP release cannot close individual sessions; bound its retained native state.
      if (shared && helper.sessionIds.length >= 10) yield* RcRef.invalidate(worker);
      return result;
    },
    (effect, input) => {
      const shared = input.operation === "generatePromptSuggestion";
      const run = effect.pipe(
        Effect.timeoutOrElse({
          duration: ANTIGRAVITY_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Antigravity text generation timed out.",
              }),
            ),
        }),
        Effect.onError(() => (shared ? RcRef.invalidate(worker) : Effect.void)),
        Effect.scoped,
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: isProviderSetupError(cause)
                  ? cause.detail
                  : isAntigravitySignInRequiredError(cause)
                    ? ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE
                    : "Antigravity text generation failed.",
                cause,
              }),
        ),
      );
      return shared ? workerLock.withPermit(run) : run;
    },
  );

  return TextGenerationOperations.fromRunner(
    "AntigravityTextGeneration",
    TextGenerationOperations.withoutInvestigation("Antigravity", runAntigravityJson),
  );
});
