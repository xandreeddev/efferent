import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import type { Readable } from "node:stream"
import { Cause, Clock, Deferred, Effect, Layer, MutableRef, Option, Queue, Result, Stream } from "effect"
import type { Context, Scope } from "effect"
import { Bash, BashError, collectBashResult, resolveBashEnv } from "@xandreed/core"
import type { BashChunk, BashEvent, BashExit, BashOptions } from "@xandreed/core"
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
 * The most events a command's stream holds before the command is made to
 * wait: a pipe read is at most 64 KB on Node, so about 1 MB of output.
 */
export const OUTPUT_BUFFER = 16

/** An event on its way into the stream, and the pipe it came from (paused until it is in); none for the events of the end. */
interface Held {
  readonly event: BashEvent
  readonly pipe: Option.Option<Readable>
}

/** How a command's output pipes feed its stream (`relayOutput`). */
export interface OutputRelay {
  /** Read `pipe` as `name`: UTF-8, a character split between reads arriving whole; an error on it fails the stream. */
  readonly attach: (name: BashChunk["stream"], pipe: Readable) => void
  /** Stop pausing the pipes: what is left of the output is read at once. */
  readonly flow: () => void
  /** The decoders' last characters, then `exit`, after everything before them; the stream ends after the exit. */
  readonly finish: (exit: BashExit) => void
}

/**
 * The bridge from a command's output pipes to its stream's buffer (`queue`,
 * which holds at most `OUTPUT_BUFFER` events). An event goes straight in
 * while there is room and nothing waits before it. Otherwise it waits, in
 * arrival order, and the pipe it came from is paused, so the command blocks
 * on a full pipe instead of its output piling up in memory; a fiber of the
 * stream's scope moves waiting events in as the reader takes them, and
 * resumes their pipes. `flow` ends the pausing, for once the command has
 * exited (what is left then is the pipes' content, and whatever a
 * background process writes in `exitGraceMs`). An error on a pipe fails the
 * stream with `SpawnFailed`.
 */
export const relayOutput = (queue: Queue.Queue<BashEvent, BashError | Cause.Done>): Effect.Effect<OutputRelay, never, Scope.Scope> => Effect.gen(function* () {
  const waiting = yield* Queue.unbounded<Held>()
  /** Events waiting or on their way in: while there are any, a new event waits behind them. */
  const behind = MutableRef.make(0)
  const flowing = MutableRef.make(false)
  const pipes = MutableRef.make<ReadonlyArray<Readable>>([])
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  const wait = (event: BashEvent, pipe: Option.Option<Readable>): void => {
    if (Option.isSome(pipe) && !MutableRef.get(flowing)) pipe.value.pause()
    MutableRef.increment(behind)
    Queue.offerUnsafe(waiting, { event, pipe })
  }
  /** Straight into the stream when nothing waits and there is room; otherwise behind what waits, with `pipe` paused. */
  const deliver = (event: BashEvent, pipe: Readable): void => {
    if (MutableRef.get(behind) > 0 || !Queue.offerUnsafe(queue, event)) wait(event, Option.some(pipe))
  }
  const chunk = (name: BashChunk["stream"], text: string): Option.Option<BashChunk> =>
    text.length === 0 ? Option.none() : Option.some({ _tag: "BashChunk", stream: name, text })
  yield* Queue.take(waiting).pipe(
    Effect.flatMap(({ event, pipe }) => Queue.offer(queue, event).pipe(Effect.andThen(Effect.sync(() => {
      MutableRef.decrement(behind)
      Option.map(pipe, (readable) => readable.resume())
      // The exit is the stream's last event.
      if (event._tag === "BashExit") Queue.endUnsafe(queue)
    })))),
    Effect.forever,
    Effect.forkScoped,
  )
  return {
    attach: (name, pipe) => {
      MutableRef.update(pipes, (all) => [...all, pipe])
      pipe.on("data", (bytes: Uint8Array) => Option.map(chunk(name, decoders[name].decode(bytes, { stream: true })), (event) => deliver(event, pipe)))
      pipe.on("error", (error) => Queue.failCauseUnsafe(queue, Cause.fail(new BashError({ reason: "SpawnFailed", message: `could not read the command's ${name}: ${errorMessageOf(error)}` }))))
    },
    flow: () => {
      MutableRef.set(flowing, true)
      MutableRef.get(pipes).forEach((pipe) => pipe.resume())
    },
    finish: (exit) => {
      Option.map(chunk("stdout", decoders.stdout.decode()), (event) => wait(event, Option.none()))
      Option.map(chunk("stderr", decoders.stderr.decode()), (event) => wait(event, Option.none()))
      wait(exit, Option.none())
    },
  }
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
 * reads arriving whole. While the command runs, its output is read only as
 * fast as the stream is (`relayOutput`): on Node a reader that falls behind
 * holds the command back on a full pipe, so output is never gathered
 * without bound (Bun reads a child's pipes ahead into its own memory, the
 * reader notwithstanding). A timeout, or a caller that stops reading before
 * the end, kills the whole group; with `killBackground` (the default) so
 * does the command's return. The stream ends once the command has exited
 * and its output has closed, or `exitGraceMs` after the exit if something
 * still holds the output open; the adapter then closes its end of the
 * output pipes, so a background process kept with `killBackground: false`
 * that still writes to them gets `EPIPE` or dies of `SIGPIPE` unless it was
 * started with its own output (`cmd > log 2>&1 &`). POSIX only (Linux and
 * macOS): it relies on process groups. Passes `bashConformance` on Bun and
 * Node (on Bun without the hold-back half of `backpressure`).
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
    /** Set once the stream's `BashExit` is on its way: from then on, stopping early no longer kills the command. */
    const finished = MutableRef.make(false)
    const output = yield* relayOutput(queue)
    const started = yield* Clock.currentTimeMillis
    const child = yield* Effect.acquireRelease(Effect.try({
      try: () => {
        const spawned = spawn(shellPath, ["-c", command], {
          cwd: run.cwd,
          env: { ...resolveBashEnv(parentEnv(), run) },
          detached: true,
          stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        })
        if (spawned.stdout !== null) output.attach("stdout", spawned.stdout)
        if (spawned.stderr !== null) output.attach("stderr", spawned.stderr)
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
    // Once the command has exited, what is left of its output is read at once rather than as the stream is read.
    output.flow()
    const drained = yield* Deferred.await(closed).pipe(Effect.timeoutOption(exitGraceMs))
    if (Option.isNone(drained)) {
      // Something the command started still holds its output open: stop reading it.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    MutableRef.set(finished, true)
    output.finish(bashExitOf({ code: end.code, signal: end.signal, timedOut, durationMs: end.at - started }))
  }), { bufferSize: OUTPUT_BUFFER })

  return Bash.of({ stream, exec: (command, run) => collectBashResult(stream(command, run)) })
})

/** The local `Bash` (`makeBash`) as a layer; building it fails with `ShellMissing` when the shell is not installed. */
export const BashLive = (options: BashLiveOptions = {}): Layer.Layer<Bash, BashError> => Layer.effect(Bash, makeBash(options))
