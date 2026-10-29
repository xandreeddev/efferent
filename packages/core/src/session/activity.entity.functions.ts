import { Effect, Option } from "effect"
import type { Duration } from "effect"
import { TaskActivity, TurnActivity } from "../ports/activity.port.js"
import type { ProcessActivity, TurnsInFlight } from "./activity.entity.js"

const noTurns: TurnsInFlight = { open: [], beginning: 0 }

/**
 * What this process is busy with now: the turns its `TurnActivity` holds
 * open or is beginning, and the work its `TaskActivity` runs. A probe that
 * is not in the context counts as nothing open, beginning or running.
 */
export const processActivity: Effect.Effect<ProcessActivity> = Effect.gen(function* () {
  const turns = yield* Effect.serviceOption(TurnActivity)
  const tasks = yield* Effect.serviceOption(TaskActivity)
  const inFlight = yield* Option.match(turns, { onNone: () => Effect.succeed(noTurns), onSome: (probe) => probe.current })
  const runningTasks = yield* Option.match(tasks, { onNone: () => Effect.succeed(0), onSome: (probe) => probe.running })
  return {
    openTurns: inFlight.open,
    beginningTurns: inFlight.beginning,
    runningTasks,
    busy: inFlight.open.length > 0 || inFlight.beginning > 0 || runningTasks > 0,
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
