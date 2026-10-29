import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { Cause, Clock, Deferred, Effect, Layer, MutableRef, Option, Queue, Result, Stream } from "effect"
import type { Context } from "effect"
import { Bash, BashError, collectBashResult, resolveBashEnv } from "@xandreed/core"
import type { BashEvent, BashOptions } from "@xandreed/core"
import { bashExitOf, errorMessageOf, executableCandidates, isClosedInput } from "./local-system.entity.functions.js"
import { localSystemDefaults } from "./local-system.entity.js"
import type { BashLiveOptions } from "./local-system.entity.js"

type BashShape = Context.Service.Shape<typeof Bash>

/** How the process ended, as its `exit` event said, and when. */
interface Exited {
  readonly code: number | null
  readonly signal: string | null
  readonly at: number
}

const isExecutableFile = (path: string): Effect.Effect<boolean> => Effect.tryPromise(() => access(path, constants.X_OK)).pipe(
  Effect.andThen(Effect.tryPromise(() => stat(path))),
  Effect.map((info) => info.isFile()),
  Effect.orElseSucceed(() => false),
)

/** The absolute path of the first executable `shell` on `path`; `ShellMissing` when there is none (there is no fallback shell). */
const resolveShell = (shell: string, path: Option.Option<string>): Effect.Effect<string, BashError> =>
  Effect.findFirst(executableCandidates(shell, path), isExecutableFile).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.fail(new BashError({
      reason: "ShellMissing",
      message: `no executable ${shell} ${shell.startsWith("/") ? "at that path" : `on the PATH (${Option.getOrElse(path, () => "unset")})`}`,
    })),
    onSome: Effect.succeed,
  })))

const checkCwd = (cwd: string): Effect.Effect<void, BashError> =>
  (cwd.startsWith("/") ? Effect.tryPromise(() => stat(cwd)).pipe(Effect.map((info) => info.isDirectory()), Effect.orElseSucceed(() => false)) : Effect.succeed(false)).pipe(
    Effect.flatMap((directory) => directory ? Effect.void : Effect.fail(new BashError({ reason: "CwdMissing", message: `cwd is not an existing absolute directory: ${cwd}` }))))

/**
 * SIGKILL the command's process group (its id is the shell's pid: the shell
 * is spawned detached, so it leads a group of its own). Before the shell
 * has exited, a group that cannot be signalled falls back to the shell
 * itself; after, only the group is signalled, since the bare pid may by then
 * belong to another process. A group with no process left (`ESRCH`) has
 * nothing to kill, and any other refusal leaves nothing more to do, so
 * neither is an error.
 */
const killGroup = (child: ChildProcess, exited: boolean): void => Option.match(Option.fromNullishOr(child.pid), {
  onNone: () => undefined,
  onSome: (pid) => {
    const group = Result.try(() => process.kill(-pid, "SIGKILL"))
    if (Result.isFailure(group) && !exited) Result.try(() => process.kill(pid, "SIGKILL"))
  },
})

/**
 * Commands on the local machine through `node:child_process`, for Node and
 * Bun: `<shell> -c <command>`, detached into a process group of its own, in
 * an environment `resolveBashEnv` builds from `parentEnv`. The shell is
 * resolved to an absolute path once, here, from the parent `PATH` (so a
 * command whose own environment has no `PATH` still runs); none fails with
 * `ShellMissing`. Each command checks its `cwd` first (`CwdMissing`); its
 * stdin is written and closed (a command that never reads it is fine), its
 * stdout and stderr decoded as UTF-8 per stream, a character split between
 * reads arriving whole. A timeout, or a caller that stops reading before
 * the end, kills the whole group; with `killBackground` (the default) so
 * does the command's return. The stream ends once the command has exited
 * and its output has closed, or `exitGraceMs` after the exit if something
 * still holds the output open; the adapter then closes its end of the
 * output pipes, so a background process kept with `killBackground: false`
 * that still writes to them gets `EPIPE` or dies of `SIGPIPE` unless it was
 * started with its own output (`cmd > log 2>&1 &`). Output is buffered
 * without bound until it is read. POSIX only (Linux and macOS): it relies
 * on process groups. Passes `bashConformance` on Bun and Node.
 */
export const makeBash = (options: BashLiveOptions = {}): Effect.Effect<BashShape, BashError> => Effect.gen(function* () {
  const { shell, killBackground, exitGraceMs } = { ...localSystemDefaults, ...options }
  const parentEnv = (): Readonly<Record<string, string | undefined>> => options.parentEnv ?? process.env
  const shellPath = yield* resolveShell(shell, Option.fromNullishOr(parentEnv()["PATH"]))

  const stream = (command: string, run: BashOptions): Stream.Stream<BashEvent, BashError> => Stream.callback<BashEvent, BashError>((queue) => Effect.gen(function* () {
    yield* checkCwd(run.cwd)
    const clock = yield* Effect.clockWith((current) => Effect.succeed(current))
    const exited = yield* Deferred.make<Exited, BashError>()
    const closed = yield* Deferred.make<void>()
    /** Set once the stream's `BashExit` is out: from then on, stopping early no longer kills the command. */
    const finished = MutableRef.make(false)
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    const emit = (name: "stdout" | "stderr", text: string): boolean => text.length > 0 && Queue.offerUnsafe(queue, { _tag: "BashChunk", stream: name, text })
    const started = yield* Clock.currentTimeMillis
    const child = yield* Effect.acquireRelease(Effect.try({
      try: () => {
        const spawned = spawn(shellPath, ["-c", command], {
          cwd: run.cwd,
          env: { ...resolveBashEnv(parentEnv(), run) },
          detached: true,
          stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        })
        spawned.stdout?.on("data", (chunk: Uint8Array) => emit("stdout", decoders.stdout.decode(chunk, { stream: true })))
        spawned.stderr?.on("data", (chunk: Uint8Array) => emit("stderr", decoders.stderr.decode(chunk, { stream: true })))
        spawned.once("error", (error) => Deferred.doneUnsafe(exited, Effect.fail(new BashError({ reason: "SpawnFailed", message: errorMessageOf(error) }))))
        spawned.once("exit", (code, signal) => Deferred.doneUnsafe(exited, Effect.succeed({ code, signal, at: clock.currentTimeMillisUnsafe() })))
        spawned.once("close", () => Deferred.doneUnsafe(closed, Effect.void))
        // A command that exits, or closes its input, before reading all of it makes the write fail with
        // EPIPE (Node reports it; Bun does not): that is the command's choice, not a failure.
        spawned.stdin?.on("error", (error) => isClosedInput(error) ? false
          : Queue.failCauseUnsafe(queue, Cause.fail(new BashError({ reason: "SpawnFailed", message: `could not write the command's stdin: ${errorMessageOf(error)}` }))))
        spawned.stdin?.end(run.stdin)
        return spawned
      },
      catch: (error) => new BashError({ reason: "SpawnFailed", message: errorMessageOf(error) }),
    }), (spawned) => Effect.sync(() => {
      if (!MutableRef.get(finished)) killGroup(spawned, Deferred.isDoneUnsafe(exited))
      spawned.stdout?.destroy()
      spawned.stderr?.destroy()
      spawned.stdin?.destroy()
    }))

    const awaited = Deferred.await(exited).pipe(Effect.map((end) => ({ end, timedOut: false })))
    const { end, timedOut } = yield* run.timeoutMs === undefined ? awaited : Deferred.await(exited).pipe(
      Effect.timeoutOption(run.timeoutMs),
      Effect.flatMap(Option.match({
        onSome: (end) => Effect.succeed({ end, timedOut: false }),
        onNone: () => Effect.sync(() => killGroup(child, Deferred.isDoneUnsafe(exited))).pipe(Effect.andThen(awaited), Effect.map(({ end }) => ({ end, timedOut: true }))),
      })),
    )
    if (killBackground) killGroup(child, true)
    const drained = yield* Deferred.await(closed).pipe(Effect.timeoutOption(exitGraceMs))
    if (Option.isNone(drained)) {
      // Something the command started still holds its output open: stop reading it.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    emit("stdout", decoders.stdout.decode())
    emit("stderr", decoders.stderr.decode())
    MutableRef.set(finished, true)
    yield* Queue.offer(queue, bashExitOf({ code: end.code, signal: end.signal, timedOut, durationMs: end.at - started }))
    yield* Queue.end(queue)
  }))

  return Bash.of({ stream, exec: (command, run) => collectBashResult(stream(command, run)) })
})

/** The local `Bash` (`makeBash`) as a layer; building it fails with `ShellMissing` when the shell is not installed. */
export const BashLive = (options: BashLiveOptions = {}): Layer.Layer<Bash, BashError> => Layer.effect(Bash, makeBash(options))
