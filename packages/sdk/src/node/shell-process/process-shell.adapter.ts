import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { Deferred, Effect, Layer, Option, Result } from "effect"
import type { Ran, RunRequest } from "../../contracts/shell/shell.entity.js"
import { ShellUnavailable } from "../../contracts/shell/shell.entity.js"
import { Shell } from "../../contracts/shell/shell.port.js"
import { CLOSE_GRACE_MS, PROCESS_SHELL_DEFAULTS } from "./process-shell.entity.js"
import type { ProcessShellOptions } from "./process-shell.entity.js"
import { keptOf, tailOf } from "./process-shell.entity.functions.js"

/** A foreign failure's words: its own message when it is an `Error`. */
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : "no reason given"

/**
 * Stop a command and every process it started: the shell was spawned detached, so it leads a process group of its
 * own whose id is its pid, and `SIGKILL` goes to the whole group. A group with no process left (`ESRCH`) has nothing to
 * stop; a process that left the group (`setsid`) is not reached. Proved on Node 24 and Bun 1.3.0 by the kit's
 * `*-kills` checks.
 */
const killGroup = (child: ChildProcess): void => {
  const pid = child.pid
  if (pid !== undefined) Result.try(() => process.kill(-pid, "SIGKILL"))
}

/** What a run holds of one output stream while the command writes: the last chunks, and the bytes dropped before them. */
interface Held {
  chunks: ReadonlyArray<Uint8Array>
  dropped: number
}

/** How the shell process ended, as its `exit` event said. */
interface ShellExit {
  readonly code: number | null
  readonly signal: string | null
}

/**
 * Commands on this machine through `node:child_process` (ADR 0028), on Node 24 and Bun: `<shell> -c <command>`,
 * spawned detached so it leads a process group of its own, in exactly the environment `env` gives (the host
 * process's own is never read), with no input. Each of stdout and stderr keeps its last `outputBytes` bytes as it is
 * written, so a command that writes without end holds little. A run ends, however it ends, by stopping the command's
 * whole group with `SIGKILL`: once it timed out (`TimedOut`), once the shell returned (what it left in the background),
 * when the fiber is interrupted, and for every run still going when the layer's scope closes. Its output is then read
 * to the end, or for `CLOSE_GRACE_MS` when a process that left the group still holds the pipes. POSIX only (Linux and
 * macOS): it relies on process groups. A starting folder that is not one, and a shell that cannot be started, fail
 * with `ShellUnavailable`.
 *
 * Not confined: a command runs with the host's rights. Each run is one span, `process_shell.run`.
 *
 * @public
 */
export const processShell = (options: ProcessShellOptions): Layer.Layer<Shell> => Layer.effect(Shell, Effect.gen(function* () {
  const shell = options.shell ?? PROCESS_SHELL_DEFAULTS.shell
  const outputBytes = options.outputBytes ?? PROCESS_SHELL_DEFAULTS.outputBytes
  const defaultTimeout = options.timeoutMs ?? PROCESS_SHELL_DEFAULTS.timeoutMs
  const env = { ...options.env }
  if (!isAbsolute(options.cwd)) return yield* Effect.die(new Error(`processShell: cwd must be an absolute folder, not ${JSON.stringify(options.cwd)}`))
  if (!isAbsolute(shell)) return yield* Effect.die(new Error(`processShell: shell must be an absolute path, not ${JSON.stringify(shell)}`))
  if (!Number.isInteger(outputBytes) || outputBytes < 1) return yield* Effect.die(new Error(`processShell: outputBytes must be a whole number of at least 1, not ${outputBytes}`))
  if (!Number.isInteger(defaultTimeout) || defaultTimeout < 1) return yield* Effect.die(new Error(`processShell: timeoutMs must be a whole number of at least 1, not ${defaultTimeout}`))
  /**
   * The commands whose shell has not yet been seen to exit, each stopped with its group when the scope closes. A run
   * leaves the set as soon as its group is stopped after the exit, so no later kill names a group id the system may
   * since have given to another process.
   */
  const running = new Set<ChildProcess>()
  yield* Effect.addFinalizer(() => Effect.sync(() => running.forEach(killGroup)))

  const folderOf = (cwd: string) => Effect.tryPromise({
    try: () => stat(cwd),
    catch: (cause) => new ShellUnavailable({ message: `the folder ${cwd} cannot be used: ${messageOf(cause)}` }),
  }).pipe(Effect.flatMap((info) => info.isDirectory() ? Effect.void : Effect.fail(new ShellUnavailable({ message: `${cwd} is not a folder` }))))

  const run = Effect.fn("process_shell.run")(function* (request: RunRequest) {
    const cwd = request.cwd === undefined ? options.cwd : resolve(options.cwd, request.cwd)
    yield* folderOf(cwd)
    const timeoutMs = request.timeoutMs ?? defaultTimeout
    const exited = yield* Deferred.make<ShellExit, ShellUnavailable>()
    const closed = yield* Deferred.make<void>()
    const out: Held = { chunks: [], dropped: 0 }
    const err: Held = { chunks: [], dropped: 0 }
    let stopped = false
    const keep = (held: Held) => (chunk: Uint8Array) => {
      const kept = keptOf([...held.chunks, chunk], outputBytes)
      held.chunks = kept.chunks
      held.dropped += kept.dropped
    }
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const child = spawn(shell, ["-c", request.command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
          child.stdout?.on("data", keep(out))
          child.stderr?.on("data", keep(err))
          child.once("error", (cause) => Deferred.doneUnsafe(exited, Effect.fail(new ShellUnavailable({ message: `${shell} could not be started: ${messageOf(cause)}` }))))
          child.once("exit", (code, signal) => Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })))
          child.once("close", () => Deferred.doneUnsafe(closed, Effect.void))
          running.add(child)
          return child
        },
        catch: (cause) => new ShellUnavailable({ message: `${shell} could not be started: ${messageOf(cause)}` }),
      }),
      (child) => Effect.gen(function* () {
        const inTime = yield* Effect.timeoutOption(Deferred.await(exited), timeoutMs)
        if (Option.isNone(inTime)) killGroup(child)
        const exit = Option.isSome(inTime) ? inTime.value : yield* Deferred.await(exited)
        // What the command left running in the background goes with it, at once: the shell was reaped as its exit was
        // heard, and its id is not given to another process before this kill in any but a system whose ids wrap around
        // within the moment between the two. After it, nothing names the group again.
        killGroup(child)
        running.delete(child)
        stopped = true
        const drained = yield* Effect.timeoutOption(Deferred.await(closed), CLOSE_GRACE_MS)
        if (Option.isNone(drained)) {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
        const stdout = tailOf(out.chunks, outputBytes)
        const stderr = tailOf(err.chunks, outputBytes)
        const ran: Ran = {
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutCut: out.dropped + stdout.cut,
          stderrCut: err.dropped + stderr.cut,
          ended: Option.isNone(inTime)
            ? { _tag: "TimedOut", afterMs: timeoutMs }
            : exit.signal !== null ? { _tag: "Killed", signal: exit.signal } : { _tag: "Exited", code: exit.code ?? 0 },
        }
        return ran
      }),
      (child) => Effect.sync(() => {
        // Interrupted, or failed, before the exit was heard: the shell's group is still this run's.
        if (!stopped) killGroup(child)
        running.delete(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
      }),
    )
  })

  return Shell.of({ run })
}))
