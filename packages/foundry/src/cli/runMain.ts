import { Cause, Effect, Exit, Fiber } from "effect"

/** The exit code of a process ended by a signal, as a shell reports it. */
const signalExitCode = (signal: NodeJS.Signals): number => signal === "SIGINT" ? 130 : 143

/**
 * Run the command line's program to its end. SIGINT (a terminal's Ctrl-C)
 * and SIGTERM interrupt it instead of ending the process, so its scopes
 * close: an implementor it started, which leads a process group of its own
 * and so gets no terminal signal, is stopped with its tool processes. A
 * second signal meets the default handler, which ends the process at once.
 * A failure or a defect the program did not handle is logged and exits 1,
 * as an unhandled rejection did.
 */
export const runMain = <A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => {
  const fiber = Effect.runFork(program)
  const onSignal = (signal: NodeJS.Signals) => {
    process.exitCode = signalExitCode(signal)
    Effect.runFork(Fiber.interrupt(fiber))
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  return Effect.runPromise(Fiber.await(fiber).pipe(
    Effect.tap((exit) => Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.logError("foundry failed", exit.cause).pipe(Effect.andThen(Effect.sync(() => { process.exitCode = 1 })))
      : Effect.void),
    Effect.ensuring(Effect.sync(() => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    })),
  ))
}
