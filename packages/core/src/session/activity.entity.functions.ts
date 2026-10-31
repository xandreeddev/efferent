import { Duration, Effect, Option } from "effect"
import { DrainActivity, TaskActivity, TurnActivity, TurnShutdown, WaitingInput } from "../ports/activity.port.js"
import type { ActiveTurn, ProcessActivity, ShutdownReport, TurnsInFlight, WaitingInputCount } from "./activity.entity.js"
import type { SessionLogError } from "./session-log.entity.js"

const noTurns: TurnsInFlight = { open: [], beginning: 0 }

/** Infallible local work probes, separate from durable queue reads. */
const workActivity = Effect.gen(function* () {
  const turns = yield* Effect.serviceOption(TurnActivity)
  const tasks = yield* Effect.serviceOption(TaskActivity)
  const drains = yield* Effect.serviceOption(DrainActivity)
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  const held = yield* Option.match(turns, { onNone: () => Effect.succeed(noTurns), onSome: (probe) => probe.current })
  const runningTasks = yield* Option.match(tasks, { onNone: () => Effect.succeed(0), onSome: (probe) => probe.running })
  const runningDrains = yield* Option.match(drains, { onNone: () => Effect.succeed(0), onSome: (probe) => probe.running })
  const stopping = yield* Option.match(shutdown, { onNone: () => Effect.succeed(false), onSome: (probe) => probe.stopping })
  return {
    openTurns: held.open,
    beginningTurns: held.beginning,
    runningTasks,
    inFlight: held.open.length > 0 || held.beginning > 0 || runningTasks > 0 || runningDrains > 0,
    stopping,
  }
})

const withWaiting = (work: Effect.Success<typeof workActivity>, counts: ReadonlyArray<WaitingInputCount>): ProcessActivity => {
  const waiting = counts.filter((count) => count.pending > 0)
  const queuedInput = waiting.reduce((total, count) => total + count.pending, 0)
  return { ...work, waiting, queuedInput, busy: work.inFlight || queuedInput > 0 }
}

/**
 * Current local work and fresh owner-checked queued-input counts. Missing
 * probes contribute nothing; failures from an installed WaitingInput remain
 * SessionLogError. Queued input is busy even without an active drainer.
 */
export const processActivity: Effect.Effect<ProcessActivity, SessionLogError> = Effect.gen(function* () {
  const queue = yield* Effect.serviceOption(WaitingInput)
  const counts = yield* Option.match(queue, { onNone: () => Effect.succeed([]), onSome: (probe) => probe.current })
  return withWaiting(yield* workActivity, counts)
})

/** No storage I/O after a timeout or when queued:false was requested. */
const cachedActivity: Effect.Effect<ProcessActivity> = Effect.gen(function* () {
  const queue = yield* Effect.serviceOption(WaitingInput)
  const counts = yield* Option.match(queue, { onNone: () => Effect.succeed([]), onSome: (probe) => probe.cached })
  return withWaiting(yield* workActivity, counts)
})

const idleWork = Effect.gen(function* () {
  const turns = yield* Effect.serviceOption(TurnActivity)
  const tasks = yield* Effect.serviceOption(TaskActivity)
  const drains = yield* Effect.serviceOption(DrainActivity)
  yield* Option.match(turns, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  yield* Option.match(tasks, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  yield* Option.match(drains, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
})

/** Read all probes again after idles, covering work that crossed between probes. */
const settled: Effect.Effect<ProcessActivity, SessionLogError> = Effect.gen(function* () {
  yield* idleWork
  const queue = yield* Effect.serviceOption(WaitingInput)
  yield* Option.match(queue, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  const now = yield* processActivity
  return now.busy ? yield* Effect.yieldNow.pipe(Effect.andThen(settled)) : now
})

const settledInFlight: Effect.Effect<ProcessActivity> = Effect.gen(function* () {
  yield* idleWork
  const now = yield* cachedActivity
  return now.inFlight ? yield* Effect.yieldNow.pipe(Effect.andThen(settledInFlight)) : now
})

/**
 * Wait for turns, tasks, active drain attempts and (by default) durable user
 * input to settle. queued:false skips fresh queue reads and queue waiting,
 * returning once !inFlight even if cached backlog keeps busy true. A timeout
 * returns local work with cached queue counts without another storage read.
 */
export function awaitIdle(options: { readonly queued: false; readonly timeout?: Duration.Input }): Effect.Effect<ProcessActivity>
export function awaitIdle(options?: { readonly queued?: boolean; readonly timeout?: Duration.Input }): Effect.Effect<ProcessActivity, SessionLogError>
export function awaitIdle(options?: { readonly queued?: boolean; readonly timeout?: Duration.Input }): Effect.Effect<ProcessActivity, SessionLogError> {
  const waiting = options?.queued === false ? settledInFlight : settled
  return Option.match(Option.fromNullishOr(options?.timeout), {
    onNone: () => waiting,
    onSome: (timeout) => Effect.timeoutOption(waiting, timeout).pipe(Effect.flatMap(Option.match({ onNone: () => cachedActivity, onSome: Effect.succeed }))),
  })
}

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
  const waited = yield* awaitIdle({ queued: false, timeout: deadline - reserve })
  if (!waited.inFlight) return { idle: true, interrupted: [], left: waited } satisfies ShutdownReport
  const interrupted = yield* Option.match(shutdown, { onNone: () => Effect.succeed<ReadonlyArray<ActiveTurn>>([]), onSome: (stopping) => stopping.interrupt })
  const left = yield* awaitIdle({ queued: false, timeout: reserve })
  yield* Effect.annotateCurrentSpan({ "efferent.shutdown.interrupted": interrupted.length, "efferent.shutdown.busy": left.busy })
  return { idle: false, interrupted, left } satisfies ShutdownReport
})
