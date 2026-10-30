import { Duration, Effect, Option } from "effect"
import { TaskActivity, TurnActivity, TurnShutdown } from "../ports/activity.port.js"
import type { ActiveTurn, ProcessActivity, ShutdownReport, TurnsInFlight } from "./activity.entity.js"

const noTurns: TurnsInFlight = { open: [], beginning: 0 }

/**
 * What this process is busy with now: the turns its `TurnActivity` holds
 * open or is beginning, the work its `TaskActivity` runs, and whether its
 * `TurnShutdown` is stopping. A probe that is not in the context counts as
 * nothing open, beginning or running, and not stopping.
 */
export const processActivity: Effect.Effect<ProcessActivity> = Effect.gen(function* () {
  const turns = yield* Effect.serviceOption(TurnActivity)
  const tasks = yield* Effect.serviceOption(TaskActivity)
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  const inFlight = yield* Option.match(turns, { onNone: () => Effect.succeed(noTurns), onSome: (probe) => probe.current })
  const runningTasks = yield* Option.match(tasks, { onNone: () => Effect.succeed(0), onSome: (probe) => probe.running })
  const stopping = yield* Option.match(shutdown, { onNone: () => Effect.succeed(false), onSome: (probe) => probe.stopping })
  return {
    openTurns: inFlight.open,
    beginningTurns: inFlight.beginning,
    runningTasks,
    busy: inFlight.open.length > 0 || inFlight.beginning > 0 || runningTasks > 0,
    stopping,
  }
})

/** Both probes idle, then both read again: a task that opened a turn (or a turn that started a task) meanwhile is waited for too. */
const settled: Effect.Effect<ProcessActivity> = Effect.gen(function* () {
  const turns = yield* Effect.serviceOption(TurnActivity)
  const tasks = yield* Effect.serviceOption(TaskActivity)
  yield* Option.match(turns, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  yield* Option.match(tasks, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  const now = yield* processActivity
  return now.busy ? yield* Effect.yieldNow.pipe(Effect.andThen(settled)) : now
})

/**
 * Wait until this process holds no turn open, begins none and runs no
 * background work at the same moment, and return that activity (`busy:
 * false`). With a `timeout`, stop waiting then and return the activity as
 * it is (`busy: true`, with what is still in flight). It admits nothing
 * itself: to drain before a shutdown, stop admitting new turns first (the
 * host's `TurnAdmission`, or its own front door), then wait, then stop the
 * host's own request fibers, then close the scope the services live in.
 */
export const awaitIdle = (options?: { readonly timeout?: Duration.Input }): Effect.Effect<ProcessActivity> => Option.match(Option.fromNullishOr(options?.timeout), {
  onNone: () => settled,
  onSome: (timeout) => Effect.timeoutOption(settled, timeout).pipe(Effect.flatMap(Option.match({ onNone: () => processActivity, onSome: Effect.succeed }))),
})

/**
 * A graceful shutdown's time: `deadline`, the whole of it, counted from the
 * call (keep it below the platform's grace period, a container's stop
 * timeout say); `reserve`, the part of it kept for the turns still running
 * at the end to store their ends and close (`DEFAULT_SHUTDOWN_RESERVE` by
 * default, never more than the deadline).
 *
 * @public
 */
export interface ShutdownOptions {
  readonly deadline: Duration.Input
  readonly reserve?: Duration.Input
}

/** @public */
export const DEFAULT_SHUTDOWN_RESERVE: Duration.Input = "2 seconds"

/** The deadline `Agent.shutdown` keeps when neither it nor `AgentConfig.shutdown` is given one: below a container's usual 30 s stop timeout. */
export const DEFAULT_SHUTDOWN_DEADLINE: Duration.Input = "25 seconds"

/**
 * Stop this process's turns within a deadline, while its services are still
 * open: refuse every new begin (`TurnShutdown.refuse`), wait until idle
 * (`awaitIdle`) for the deadline less its reserve, then close the turns
 * still running as interrupted with `turn.shutdown`, resumable
 * (`TurnShutdown.interrupt`), and wait out the reserve for their scopes to
 * close and the tasks they stop to end. It reads the current services: a
 * `Sessions` without `TurnShutdown` is waited for and never interrupted.
 * Then stop the host's own request fibers and close the services' scope.
 */
export const shutdownGracefully = Effect.fn("process.shutdown")(function* (options: ShutdownOptions) {
  const deadline = Math.max(0, Duration.toMillis(options.deadline))
  const reserve = Math.min(deadline, Math.max(0, Duration.toMillis(options.reserve ?? DEFAULT_SHUTDOWN_RESERVE)))
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  yield* Option.match(shutdown, { onNone: () => Effect.void, onSome: (stopping) => stopping.refuse })
  const waited = yield* awaitIdle({ timeout: deadline - reserve })
  if (!waited.busy) return { idle: true, interrupted: [], left: waited } satisfies ShutdownReport
  const interrupted = yield* Option.match(shutdown, { onNone: () => Effect.succeed<ReadonlyArray<ActiveTurn>>([]), onSome: (stopping) => stopping.interrupt })
  const left = yield* awaitIdle({ timeout: reserve })
  yield* Effect.annotateCurrentSpan({ "efferent.shutdown.interrupted": interrupted.length, "efferent.shutdown.busy": left.busy })
  return { idle: false, interrupted, left } satisfies ShutdownReport
})
