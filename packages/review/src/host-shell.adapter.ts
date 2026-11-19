import { Effect, Layer, Match } from "effect"
import { Shell } from "@xandreed/sdk"
import { processShell } from "@xandreed/sdk/node"
import { CommandFailed, OutputCut } from "./host-command.entity.js"
import type { Whole } from "./host-command.entity.js"
import { commandLine } from "./host-command.entity.functions.js"
import { HostShell } from "./host-shell.port.js"

/** How much of each stream a host command keeps: far more than any output the reviewer parses. */
export const HOST_OUTPUT_BYTES = 256 * 1024 * 1024

/** How long a host command may run when it names no time: ten minutes, for a first clone. */
export const HOST_TIMEOUT_MS = 600_000

/**
 * How the host's shell runs: the folder a command starts in when it names none, the environment it keeps (the
 * host's, which `main.ts` reads), and, for tests, a smaller output bound or time.
 */
export interface HostShellOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly outputBytes?: number
  readonly timeoutMs?: number
}

/** The host's shell over the kernel's `processShell`, given the host's environment and a large output bound. */
export const hostShell = (options: HostShellOptions): Layer.Layer<HostShell> =>
  Layer.effect(HostShell, Effect.gen(function* () {
    const shell = yield* Shell
    return HostShell.of({ run: shell.run })
  })).pipe(
    Layer.provide(processShell({
      cwd: options.cwd,
      env: options.env,
      outputBytes: options.outputBytes ?? HOST_OUTPUT_BYTES,
      timeoutMs: options.timeoutMs ?? HOST_TIMEOUT_MS,
    })),
  )

/** The end of a text, for a failure's message: its last lines, at most 600 characters. */
const endOf = (text: string): string => text.trim().slice(-600)

/** What a host command is asked: where it starts, how long it may run, and which exit codes are not failures. */
export interface WholeOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly exits?: ReadonlyArray<number>
}

/**
 * Run `args` on the host's shell, each argument quoted, and answer its whole output: a cut stdout or stderr fails
 * with `OutputCut`, an exit code not in `exits` (0 by default), a timeout or a signal with `CommandFailed` naming the
 * command and the end of its stderr, and a shell that refuses or cannot run it with `CommandFailed` too.
 */
export const runWhole = Effect.fn("host_shell.run")(function* (args: ReadonlyArray<string>, options: WholeOptions = {}) {
  const command = commandLine(args)
  const shell = yield* HostShell
  const ran = yield* shell.run({
    command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }).pipe(
    Effect.catchTag("ShellRefused", (refused) => Effect.fail(new CommandFailed({ reason: "refused", command, message: refused.reason }))),
    Effect.catchTag("ShellUnavailable", (unavailable) => Effect.fail(new CommandFailed({ reason: "unavailable", command, message: unavailable.message }))),
  )
  const cut = ran.stdoutCut + ran.stderrCut
  if (cut > 0) return yield* Effect.fail(new OutputCut({ command, cut, message: `${args[0] ?? "the command"} wrote more than the shell keeps (${cut} bytes cut), so its output is not read` }))
  const allowed = options.exits ?? [0]
  return yield* Match.valueTags(ran.ended, {
    Exited: ({ code }) => allowed.includes(code)
      ? Effect.succeed<Whole>({ stdout: ran.stdout, stderr: ran.stderr, code })
      : Effect.fail(new CommandFailed({ reason: "exited", command, message: `exited with ${code}: ${endOf(ran.stderr || ran.stdout)}` })),
    TimedOut: ({ afterMs }) => Effect.fail(new CommandFailed({ reason: "timed-out", command, message: `stopped after ${afterMs} ms` })),
    Killed: ({ signal }) => Effect.fail(new CommandFailed({ reason: "killed", command, message: `killed by ${signal}` })),
  })
})
