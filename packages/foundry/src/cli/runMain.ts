import { Cause, Effect, Exit, Fiber } from "effect"
import { killImplementorGroups } from "../adapters/claudeImplementor.js"

/** The exit code of a process ended by a signal, as a shell reports it. */
const signalExitCode = (signal: NodeJS.Signals): number => signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143

/** The signals that stop the command line: a terminal's Ctrl-C, a supervisor's stop, the terminal closed. */
const STOPPING: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"]

/**
 * Run the command line's program to its end. The first SIGINT (a terminal's
 * Ctrl-C), SIGTERM or SIGHUP (the terminal closed) interrupts it instead of
 * ending the process, so its scopes close: an implementor it started, which
 * leads a process group of its own and so gets no terminal signal, is
 * stopped with its tool processes. A second signal of any of them ends the
 * process at once, after killing every implementor group still running
 * (`killImplementorGroups`), as does any exit before the program's end. A
 * process killed outright (SIGKILL, the out-of-memory killer) runs no
 * handler, so its implementors are not stopped. A failure or a defect the
 * program did not handle is logged and exits 1, as an unhandled rejection
 * did.
 */
export const runMain = <A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => {
  const fiber = Effect.runFork(program)
  const signalled = { once: false }
  const detach = () => {
    STOPPING.forEach((signal) => process.off(signal, onSignal))
    process.off("exit", killImplementorGroups)
  }
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled.once) {
      detach()
      killImplementorGroups()
      process.exit(signalExitCode(signal))
    }
    signalled.once = true
    process.exitCode = signalExitCode(signal)
    Effect.runFork(Fiber.interrupt(fiber))
  }
  STOPPING.forEach((signal) => process.on(signal, onSignal))
  process.on("exit", killImplementorGroups)
  return Effect.runPromise(Fiber.await(fiber).pipe(
    Effect.tap((exit) => Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.logError("foundry failed", exit.cause).pipe(Effect.andThen(Effect.sync(() => { process.exitCode = 1 })))
      : Effect.void),
    Effect.ensuring(Effect.sync(detach)),
  ))
}
