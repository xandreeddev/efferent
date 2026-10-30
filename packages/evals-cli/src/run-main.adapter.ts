import { Effect, Exit, Runtime } from "effect"
import type { EvaluationError } from "@xandreed/evals"

/**
 * What a command line needs of its process: the stop signals, the exit code and an error line.
 *
 * @public
 */
export interface CliProcess {
  readonly once: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown
  readonly off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown
  readonly setExitCode: (code: number) => void
  readonly printError: (line: string) => void
}

/** @public */
export const nodeProcess: CliProcess = {
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  setExitCode: (code) => {
    process.exitCode = code
  },
  printError: (line) => console.error(line),
}

const signals = ["SIGINT", "SIGTERM"] as const

/**
 * Run a command to completion as the process's main fiber. SIGINT or SIGTERM
 * interrupts it, so its finalizers run: trials settle as `cancelled` and
 * scoped worlds close; a second signal finds no listener and ends the
 * process. The exit code is the command's own (2 for a failed blocking gate),
 * 1 after a typed failure (printed as `code: message`) or a defect, 130 after
 * an interruption.
 *
 * @public
 */
export const runCliMain = (program: Effect.Effect<number, EvaluationError>, host: CliProcess = nodeProcess): void =>
  Runtime.makeRunMain(({ fiber, teardown }) => {
    const stop = () => fiber.interruptUnsafe()
    signals.forEach((signal) => host.once(signal, stop))
    fiber.addObserver((exit) => {
      signals.forEach((signal) => host.off(signal, stop))
      teardown(exit, host.setExitCode)
    })
  })(
    program.pipe(
      Effect.catch((error) => Effect.sync(() => host.printError(`${error.code}: ${error.message}`)).pipe(Effect.as(1))),
      Effect.flatMap((code) => Effect.sync(() => host.setExitCode(code))),
    ),
    // The program sets its own code on success; the default teardown would overwrite it with 0.
    { teardown: (exit, onExit) => Exit.isSuccess(exit) ? undefined : Runtime.defaultTeardown(exit, onExit) },
  )
