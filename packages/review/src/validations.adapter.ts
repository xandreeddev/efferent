import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Match, Option } from "effect"
import { Shell, ShellRefused, ShellUnavailable } from "@xandreed/sdk"
import type { Ran } from "@xandreed/sdk"
import { processShell } from "@xandreed/sdk/node"
import { HOST_OUTPUT_BYTES } from "./host-shell.adapter.js"
import type { LogDigest } from "./log-digest.entity.js"
import { digestLog } from "./log-digest.entity.functions.js"
import { ReviewLogs } from "./review-logs.port.js"
import type { ValidationRequest } from "./validations.entity.js"
import { Validations } from "./validations.port.js"

/**
 * A `Shell` that runs only `commands`, each exactly as written, over the one it is given; any other command is
 * refused with `ShellRefused` and not run.
 */
export const allowOnly = (commands: ReadonlyArray<string>) => <E, R>(shell: Layer.Layer<Shell, E, R>): Layer.Layer<Shell, E, R> =>
  Layer.effect(Shell, Effect.gen(function* () {
    const inner = yield* Shell
    return Shell.of({
      run: (request) => commands.includes(request.command)
        ? inner.run(request)
        : Effect.fail(new ShellRefused({ reason: "only the review's own commands run here", message: `declined ${request.command.slice(0, 200)}` })),
    })
  })).pipe(Layer.provide(shell))

/** How a command ended, in words, and its exit code when it exited. */
const endedOf = (ran: Ran): { readonly ended: string; readonly exit: Option.Option<number> } => Match.valueTags(ran.ended, {
  Exited: ({ code }) => ({ ended: `exited with ${code}`, exit: Option.some(code) }),
  TimedOut: ({ afterMs }) => ({ ended: `timed out after ${afterMs} ms`, exit: Option.none() }),
  Killed: ({ signal }) => ({ ended: `killed by ${signal}`, exit: Option.none() }),
})

/** A command's log as it is kept: its stdout, then its stderr, each with what the shell cut said first. */
const logText = (ran: Ran): string => [
  ...(ran.stdoutCut > 0 ? [`[${ran.stdoutCut} bytes of stdout cut before this]`] : []),
  ran.stdout,
  ...(ran.stderr.length > 0 || ran.stderrCut > 0 ? ["--- stderr ---", ...(ran.stderrCut > 0 ? [`[${ran.stderrCut} bytes of stderr cut before this]`] : []), ran.stderr] : []),
].join("\n")

/**
 * How the validations run: the host's `PATH` (the one variable a command is given besides `HOME`), and, for tests, a
 * smaller output bound.
 */
export interface ProcessValidationsOptions {
  readonly path: string
  readonly outputBytes?: number
}

/**
 * Validations through the kernel's `processShell`, under `allowOnly` the request's commands: each in the worktree with
 * exactly `PATH` (the host's) and `HOME` (a folder made for the run and deleted after it), no other variable, so no key
 * of the host's reaches a command of the pull request's; the request's time each; the whole log kept as
 * `<logFolder>/run-<n>.log`.
 */
export const processValidations = (options: ProcessValidationsOptions): Layer.Layer<Validations, never, ReviewLogs> => Layer.effect(Validations, Effect.gen(function* () {
  const logs = yield* ReviewLogs
  const run = Effect.fn("validations.run")(function* (request: ValidationRequest) {
    const home = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "efferent-review-home-")),
        catch: (cause) => new ShellUnavailable({ message: `a home folder for the commands could not be made: ${cause instanceof Error ? cause.message : "no reason given"}` }),
      }),
      (folder) => Effect.tryPromise(() => rm(folder, { recursive: true, force: true })).pipe(Effect.ignore({ log: "Warn", message: "the commands' home folder could not be deleted" })),
    )
    const shell = allowOnly(request.commands)(processShell({
      cwd: request.cwd,
      env: { PATH: options.path, HOME: home },
      outputBytes: options.outputBytes ?? HOST_OUTPUT_BYTES,
      timeoutMs: request.timeoutMs,
    }))
    return yield* Effect.forEach(request.commands, (command, index) => Effect.gen(function* () {
      const ran = yield* (yield* Shell).run({ command })
      const text = logText(ran)
      const logPath = yield* logs.keep(`${request.logFolder}/run-${index + 1}.log`, text)
      const { ended, exit } = endedOf(ran)
      const digest: LogDigest = { source: { _tag: "Command", command }, exit, ended, digest: digestLog(text, request.changedPaths, request.limits), logPath }
      return digest
    }), { concurrency: 1 }).pipe(Effect.provide(shell))
  }, Effect.scoped)
  return Validations.of({ run })
}))
