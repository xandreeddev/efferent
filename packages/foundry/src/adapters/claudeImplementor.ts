import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Deferred, Effect, Layer, Option, Result } from "effect"
import { ImplementorError } from "../domain/Errors.js"
import type { Spec } from "../domain/Spec.js"
import { Implementor } from "../ports/Implementor.js"
import type { ImplementInput } from "../ports/Implementor.js"

export const implementationPrompt = (spec: Spec, feedback: Option.Option<string>): string =>
  [
    `Implement the following in THIS directory (write TypeScript under ./src). Do not ask questions; just write the code.`,
    ``,
    `## Goal`,
    spec.goal,
    ``,
    `## Acceptance`,
    ...spec.acceptance.map((a) => `- ${a}`),
    ...Option.match(feedback, {
      onNone: () => [],
      onSome: (brief) => [``, `## Previous attempt was rejected`, brief],
    }),
  ].join("\n")

const IMPLEMENT_TIMEOUT_MS = 10 * 60 * 1000
/** How long an implementor that is stopped may take to stop the processes it started before they are all killed. */
const STOP_GRACE_MS = 3_000
/** How long the implementor's output is read after it exits: a process it left may hold the pipes open. */
const OUTPUT_GRACE_MS = 1_000

/**
 * Signal the implementor's process group (it is spawned detached, so its pid
 * is the group's id): its tool processes are stopped with it. Before the
 * implementor has exited, a group that cannot be signalled falls back to the
 * implementor itself; after, only the group is signalled, since the bare pid
 * may belong to another process. A group with no process left (`ESRCH`) has
 * nothing to stop, so no failure is an error here.
 */
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals, exited: boolean): void => Option.match(Option.fromNullishOr(child.pid), {
  onNone: () => undefined,
  onSome: (pid) => {
    const group = Result.try(() => process.kill(-pid, signal))
    if (Result.isFailure(group) && !exited) Result.try(() => child.kill(signal))
  },
})

/**
 * A real agent behind the same port — `claude -p` in the workspace (the
 * precedent set by the runtime's `Verifier`). Skeleton-minimal: no receipt
 * introspection (the snapshot + gates judge the result, not the agent's
 * self-report). The implementor leads a process group of its own; when the
 * attempt ends (an exit, its deadline or an interruption) the group gets
 * SIGTERM, `STOP_GRACE_MS` for the implementor to stop what it started, then
 * SIGKILL, so no tool process it left keeps changing the workspace that the
 * gates, or the next attempt, then read.
 */
export const implementCommand = (input: ImplementInput, command: ReadonlyArray<string>, timeoutMs = IMPLEMENT_TIMEOUT_MS) => Effect.scoped(Effect.gen(function* () {
    const failed = (cause: unknown) => new ImplementorError({ attempt: input.attempt, message: "claude execution failed", cause })
    /** How the implementor ended: its exit code, or the signal that ended it. */
    const exited = yield* Deferred.make<string, ImplementorError>()
    const closed = yield* Deferred.make<void>()
    const errorText = { text: "" }
    const [program, ...args] = command
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const child = spawn(program ?? "", args, { cwd: input.workspaceDir, detached: true, stdio: ["ignore", "pipe", "pipe"] })
          child.once("error", (cause) => { Deferred.doneUnsafe(exited, Effect.fail(failed(cause))) })
          child.once("exit", (code, signal) => { Deferred.doneUnsafe(exited, Effect.succeed(code === null ? `on ${signal ?? "an unknown signal"}` : String(code))) })
          child.once("close", () => { Deferred.doneUnsafe(closed, Effect.void) })
          child.stdout?.resume()
          child.stderr?.on("data", (bytes: Buffer) => { errorText.text = (errorText.text + bytes.toString("utf8")).slice(0, 2000) })
          return child
        },
        catch: failed,
      }),
      (child) => Effect.gen(function* () {
        signalGroup(child, "SIGTERM", yield* Deferred.isDone(exited))
        yield* Deferred.await(exited).pipe(Effect.timeoutOrElse({ duration: STOP_GRACE_MS, orElse: () => Effect.void }), Effect.ignore({ log: "Debug", message: "the implementor failed while stopping" }))
        signalGroup(child, "SIGKILL", yield* Deferred.isDone(exited))
        yield* Deferred.await(exited).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.logWarning("the implementor did not acknowledge termination") }),
          Effect.ignore({ log: "Warn", message: "could not finish implementor cleanup" }),
        )
      }),
    )
    const ended = yield* Deferred.await(exited).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(failed(new Error("implementor deadline exceeded"))) }))
    yield* Deferred.await(closed).pipe(Effect.timeoutOrElse({ duration: OUTPUT_GRACE_MS, orElse: () => Effect.void }))
    if (ended !== "0") return yield* Effect.fail(new ImplementorError({ attempt: input.attempt, message: `claude exited ${ended}: ${errorText.text}` }))
    return { filesTouched: [] }
  }))

export const ClaudeCliImplementorLive: Layer.Layer<Implementor> = Layer.succeed(Implementor, { implement: (input) => implementCommand(input, ["claude", "-p", implementationPrompt(input.spec, input.feedback), "--permission-mode", "acceptEdits"]) })
