import { Clock, Duration, Effect, Exit, Fiber, Option } from "effect"
import { DrainActivity, TaskActivity, TurnActivity, TurnShutdown, WaitingInput } from "../ports/activity.port.js"
import { BackgroundWorkers } from "../ports/background-workers.port.js"
import type { BackgroundWorker } from "../ports/background-workers.port.js"
import type { ActiveTurn, ProcessActivity, ShutdownReport, TurnsInFlight, WaitingInputCount } from "./activity.entity.js"
import type { SessionLogError } from "./session-log.entity.js"

const noTurns: TurnsInFlight = { open: [], beginning: 0 }

/** Infallible local work probes, separate from durable queue reads. */
const workActivity = Effect.gen(function* () {
  const turns = yield* Effect.serviceOption(TurnActivity)
  const tasks = yield* Effect.serviceOption(TaskActivity)
  const drains = yield* Effect.serviceOption(DrainActivity)
  const workers = yield* Effect.serviceOption(BackgroundWorkers)
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  const held = yield* Option.match(turns, { onNone: () => Effect.succeed(noTurns), onSome: (probe) => probe.current })
  const runningTasks = yield* Option.match(tasks, { onNone: () => Effect.succeed(0), onSome: (probe) => probe.running })
  const runningDrains = yield* Option.match(drains, { onNone: () => Effect.succeed(0), onSome: (probe) => probe.running })
  const runningWorkers = yield* Effect.forEach(Option.getOrElse(workers, () => []), (worker) => worker.running, { concurrency: 1 }).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)))
  const stopping = yield* Option.match(shutdown, { onNone: () => Effect.succeed(false), onSome: (probe) => probe.stopping })
  return {
    openTurns: held.open,
    beginningTurns: held.beginning,
    runningTasks,
    ...(Option.isSome(workers) ? { runningWorkers } : {}),
    inFlight: held.open.length > 0 || held.beginning > 0 || runningTasks > 0 || runningDrains > 0 || runningWorkers > 0,
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
  const workers = yield* Effect.serviceOption(BackgroundWorkers)
  yield* Option.match(turns, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  yield* Option.match(tasks, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  yield* Option.match(drains, { onNone: () => Effect.void, onSome: (probe) => probe.idle })
  yield* Effect.forEach(Option.getOrElse(workers, () => []), (worker) => worker.idle, { concurrency: 1, discard: true })
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

const remainingUntil = (deadline: number): Effect.Effect<number> => Clock.currentTimeMillis.pipe(Effect.map((now) => Math.max(0, deadline - now)))

/** Worker callbacks are interruptible and share one deadline, rather than receiving a fresh timeout each. */
const workerOperation = (workers: ReadonlyArray<BackgroundWorker>, operation: "stop" | "interrupt", deadline: number): Effect.Effect<void> =>
  Effect.forEach(workers, (worker) => remainingUntil(deadline).pipe(Effect.flatMap((remaining) =>
    Effect.suspend(() => worker[operation]).pipe(
      Effect.interruptible,
      Effect.timeoutOption(remaining),
      Effect.flatMap((result) => Option.isNone(result)
        ? Effect.logWarning("a background worker did not finish its shutdown operation before the deadline", { worker: worker.id, operation })
        : Effect.void),
      Effect.catchCause((cause) => Effect.logWarning("a background worker shutdown operation failed", { worker: worker.id, operation }, cause)),
    ),
  )), { concurrency: 1, discard: true })

const shutdownWithWorkers = Effect.fnUntraced(function* (workers: ReadonlyArray<BackgroundWorker>, deadlineMs: number, reserve: number): Effect.fn.Return<ShutdownReport> {
  const deadline = (yield* Clock.currentTimeMillis) + deadlineMs
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  yield* Option.match(shutdown, { onNone: () => Effect.void, onSome: (stopping) => stopping.refuse })
  const waited = yield* awaitIdle({ queued: false, timeout: yield* remainingUntil(deadline - reserve) })
  // Held turns include their post-commit observers: they enqueue while workers and stores remain open.
  yield* workerOperation(workers, "stop", deadline)
  if (!waited.inFlight) {
    const left = yield* awaitIdle({ queued: false, timeout: yield* remainingUntil(deadline) })
    if (!left.inFlight) return { idle: true, interrupted: [], left }
  }
  const closing = yield* Effect.forkDetach(Option.match(shutdown, { onNone: () => Effect.succeed<ReadonlyArray<ActiveTurn>>([]), onSome: (stopping) => stopping.interrupt }))
  // Leave a small part of the existing reserve for interrupting workers and their lease cleanup.
  const cleanup = Math.min(100, reserve / 2)
  const draining = yield* awaitIdle({ queued: false, timeout: yield* remainingUntil(deadline - cleanup) })
  if (draining.runningWorkers !== undefined && draining.runningWorkers > 0) yield* workerOperation(workers, "interrupt", deadline)
  const closed = yield* Fiber.await(closing).pipe(Effect.timeoutOption(yield* remainingUntil(deadline)))
  const interrupted = Option.match(Option.flatMap(closed, Exit.getSuccess), { onNone: () => waited.openTurns, onSome: (turns) => turns })
  const left = yield* awaitIdle({ queued: false, timeout: yield* remainingUntil(deadline) })
  yield* Effect.annotateCurrentSpan({ "efferent.shutdown.interrupted": interrupted.length, "efferent.shutdown.busy": left.busy })
  return { idle: false, interrupted, left }
})

/**
 * Stop this process's turns within a deadline, while its services are still
 * open: refuse every new begin (`TurnShutdown.refuse`), wait until idle
 * (`awaitIdle`) for the deadline less its reserve, then close the turns
 * still running as interrupted with `turn.shutdown`, resumable
 * (`TurnShutdown.interrupt`), and wait out the reserve for their scopes to
 * close and the tasks they stop to end. Closing the turns counts in the
 * reserve: a store that does not answer within it does not hold the report
 * back (the turns still closing are then the ones reported, and `left`
 * counts them while they run). It reads the current services: a `Sessions`
 * without `TurnShutdown` is waited for and never interrupted. Then stop the
 * host's own request fibers and close the services' scope.
 */
export const shutdownGracefully = Effect.fn("process.shutdown")(function* (options: ShutdownOptions) {
  const deadline = Math.max(0, Duration.toMillis(options.deadline))
  const reserve = Math.min(deadline, Math.max(0, Duration.toMillis(options.reserve ?? DEFAULT_SHUTDOWN_RESERVE)))
  const workers = yield* Effect.serviceOption(BackgroundWorkers)
  if (Option.isSome(workers) && workers.value.length > 0) return yield* shutdownWithWorkers(workers.value, deadline, reserve)
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  yield* Option.match(shutdown, { onNone: () => Effect.void, onSome: (stopping) => stopping.refuse })
  const waited = yield* awaitIdle({ queued: false, timeout: deadline - reserve })
  if (!waited.inFlight) return { idle: true, interrupted: [], left: waited } satisfies ShutdownReport
  const closingFrom = yield* Clock.currentTimeMillis
  // Detached, so a reserve that runs out leaves it closing the turns rather than waiting for its stores to answer.
  const closing = yield* Effect.forkDetach(Option.match(shutdown, { onNone: () => Effect.succeed<ReadonlyArray<ActiveTurn>>([]), onSome: (stopping) => stopping.interrupt }))
  const closed = yield* Fiber.await(closing).pipe(Effect.timeoutOption(reserve))
  const interrupted = Option.match(Option.flatMap(closed, Exit.getSuccess), { onNone: () => waited.openTurns, onSome: (turns) => turns })
  const spent = (yield* Clock.currentTimeMillis) - closingFrom
  const left = yield* awaitIdle({ queued: false, timeout: Math.max(0, reserve - spent) })
  yield* Effect.annotateCurrentSpan({ "efferent.shutdown.interrupted": interrupted.length, "efferent.shutdown.busy": left.busy })
  return { idle: false, interrupted, left } satisfies ShutdownReport
})
