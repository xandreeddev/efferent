import process from "node:process"
import { Cause, Deferred, Effect, Exit, Logger, MutableRef, Option, Predicate, Result, Schema } from "effect"
import { harnessError } from "@xandreed/core"
import type { ProcessHostOptions } from "./process-host.entity.js"
import { serveProcess } from "./process-host.adapter.js"
import { PROCESS_EXIT_CODES, ProcessRuntimeConfig } from "./process-runtime.entity.js"
import { StdioPeerLive } from "./stdio-peer.adapter.js"
import type { StdioPeerOptions } from "./stdio-peer.adapter.js"

/** The native entry point's settings, beside the reusable server's host binding. @public */
export interface RunProcessHostOptions<E = never> extends ProcessHostOptions<E> {
  readonly peer?: StdioPeerOptions
  /** Independent of graceful shutdown and scope finalizers; defaults to 30 seconds after stopping begins. */
  readonly hardDeadlineMs?: number
}

/**
 * Run a host's entry module until the process exits. The first signal starts
 * graceful shutdown, a second signal exits immediately, and an independent
 * timer bounds asynchronous stuck work, writes and finalizers. Use serveProcess
 * when embedding the server without owning the native process.
 * @public
 */
export const runProcessHost = <E>(options: RunProcessHostOptions<E>): Promise<never> => {
  const signal = Deferred.makeUnsafe<void>()
  const firstSignal = MutableRef.make<Option.Option<"SIGINT" | "SIGTERM">>(Option.none())
  const timer = MutableRef.make<Option.Option<ReturnType<typeof setTimeout>>>(Option.none())
  const listeners = MutableRef.make<Option.Option<Readonly<Record<"SIGINT" | "SIGTERM", () => void>>>>(Option.none())
  const program = Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(ProcessRuntimeConfig)({ hardDeadlineMs: options.hardDeadlineMs ?? 30_000 }).pipe(
      Effect.mapError(() => harnessError("config.options", "The process host hard deadline is invalid.")),
    )
    // Native timers and signal handlers deliberately live outside the setup
    // scope: an uninterruptible finalizer must not postpone the forced exit.
    const startTimer = (): void => {
      if (Option.isNone(MutableRef.get(timer))) {
        MutableRef.set(timer, Option.some(setTimeout(() => process.exit(PROCESS_EXIT_CODES.hardDeadline), config.hardDeadlineMs)))
      }
    }
    const onSignal = (name: "SIGINT" | "SIGTERM"): void => {
      if (Option.isSome(MutableRef.get(firstSignal))) process.exit(PROCESS_EXIT_CODES[name])
      MutableRef.set(firstSignal, Option.some(name))
      startTimer()
      Deferred.doneUnsafe(signal, Effect.void)
    }
    const handlers = { SIGINT: () => onSignal("SIGINT"), SIGTERM: () => onSignal("SIGTERM") }
    yield* Effect.sync(() => {
      process.on("SIGINT", handlers.SIGINT)
      process.on("SIGTERM", handlers.SIGTERM)
      MutableRef.set(listeners, Option.some(handlers))
    })
    const stopping = Effect.sync(startTimer).pipe(Effect.andThen(options.onStopping ?? Effect.void))
    const stop = Effect.raceFirst(Deferred.await(signal), options.stop ?? Effect.never)
    return yield* serveProcess({ ...options, stop, onStopping: stopping }).pipe(
      // This observer runs before the surrounding scope closes resources.
      Effect.onExit(() => Effect.sync(startTimer)),
      Effect.provide(StdioPeerLive(options.peer)),
      Effect.scoped,
    )
  }).pipe(Effect.provideService(Logger.LogToStderr, true))

  return Effect.runPromiseExit(program).then((exit) => {
    Option.match(MutableRef.get(listeners), { onNone: () => undefined, onSome: (handlers) => {
      process.removeListener("SIGINT", handlers.SIGINT)
      process.removeListener("SIGTERM", handlers.SIGTERM)
    } })
    Option.match(MutableRef.get(timer), { onNone: () => undefined, onSome: clearTimeout })
    const code = Option.match(MutableRef.get(firstSignal), {
      onSome: (name) => PROCESS_EXIT_CODES[name],
      onNone: () => Exit.match(exit, {
        onSuccess: () => PROCESS_EXIT_CODES.clean,
        onFailure: (cause) => Result.match(Cause.findError(cause), {
          onFailure: () => PROCESS_EXIT_CODES.failure,
          onSuccess: (error) => Predicate.isTagged(error, "ProcessHostError") && error.reason === "Protocol"
            ? PROCESS_EXIT_CODES.protocol : PROCESS_EXIT_CODES.failure,
        }),
      }),
    })
    return process.exit(code)
  })
}
