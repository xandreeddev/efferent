import { Effect, Layer, Match, Option } from "effect"
import { Shell, ShellRefused } from "@xandreed/sdk"
import type { Ran } from "@xandreed/sdk"
import type { LogDigest } from "./log-digest.entity.js"
import { digestLog } from "./log-digest.entity.functions.js"
import { ReviewLogs } from "./review-logs.port.js"
import type { ValidationRequest } from "./validations.entity.js"
import { Validations } from "./validations.port.js"

/**
 * A `Shell` that runs only `commands`, each exactly as written, over the one it is given; any other command is
 * refused with `ShellRefused` and not run. A guard on which commands run, never isolation: what a listed command can
 * reach is the inner shell's to bound.
 */
export const allowOnly = (commands: ReadonlyArray<string>, inner: Shell["Service"]): Shell["Service"] => Shell.of({
  run: (request) => commands.includes(request.command)
    ? inner.run(request)
    : Effect.fail(new ShellRefused({ reason: "only the review's own commands run here", message: `declined ${request.command.slice(0, 200)}` })),
})

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
 * Validations over the `Shell` the host provides, which MUST be a sandbox: a pull request's commands are the pull
 * request's code, and a process of the host's user can read the host's environment, credentials and clones whatever
 * variables it is given. None ships yet, so the command line provides no `Validations` and runs nothing. Each command
 * runs in the worktree under `allowOnly` the request's commands, with the request's time; its whole log is kept as
 * `<logFolder>/run-<n>.log`, stdout then stderr, and digested.
 */
export const shellValidations: Layer.Layer<Validations, never, ReviewLogs | Shell> = Layer.effect(Validations, Effect.gen(function* () {
  const logs = yield* ReviewLogs
  const sandbox = yield* Shell
  const run = Effect.fn("validations.run")(function* (request: ValidationRequest) {
    const shell = allowOnly(request.commands, sandbox)
    return yield* Effect.forEach(request.commands, (command, index) => Effect.gen(function* () {
      const ran = yield* shell.run({ command, cwd: request.cwd, timeoutMs: request.timeoutMs })
      const text = logText(ran)
      const logPath = yield* logs.keep(`${request.logFolder}/run-${index + 1}.log`, text)
      const { ended, exit } = endedOf(ran)
      const digest: LogDigest = { source: { _tag: "Command", command }, exit, ended, digest: digestLog(text, request.changedPaths, request.limits), logPath }
      return digest
    }), { concurrency: 1 })
  })
  return Validations.of({ run })
}))
