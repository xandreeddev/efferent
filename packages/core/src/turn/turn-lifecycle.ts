import { Effect, Exit, Option } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import { RunContext } from "../ports/run-context.port.js"
import type { StepLoop } from "../ports/step-loop.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import { TurnMemory, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnRunOptions } from "../ports/turn-scope.port.js"
import type { Turn, TurnOutcome, TurnTools } from "../ports/turn.port.js"
import { harnessDefectsAsFailures } from "./turn-bus.js"
import { runTurnLoop } from "./turn-run.js"
import type { TurnRunServices } from "./turn-run.js"

const failed: TurnOutcome = { outcome: "failed", reply: Option.none() }

/** Open the turn's tools (once). Their handlers run with the services of where this runs: open them inside the host's layer. */
export const openTurnTools: Effect.Effect<RunTools, HarnessError, TurnToolbox> =
  TurnToolbox.pipe(Effect.flatMap((toolbox) => toolbox.open))

/** The host's view of the open tools; skills the host activates are recorded as its own. */
export const turnTools: Effect.Effect<TurnTools, HarnessError, TurnToolbox> = TurnToolbox.pipe(
  Effect.flatMap((toolbox) => toolbox.tools),
  Effect.map((tools): TurnTools => ({
    match: tools.match,
    apply: tools.apply,
    select: tools.select,
    activate: (skills) => tools.activate(skills, "host"),
    active: tools.active,
    skills: tools.skills,
  })),
)

/** Await the tasks, then drain the background reactions, again until a round starts nothing new. */
export const settleTurn: Effect.Effect<void, HarnessError, TurnEvents | TurnTasks> = Effect.gen(function* () {
  const events = yield* TurnEvents
  const tasks = yield* TurnTasks
  const activity = Effect.zipWith(tasks.activity, events.activity, (forked, delivered) => forked + delivered)
  const settle: Effect.Effect<void, HarnessError> = Effect.gen(function* () {
    const before = yield* activity
    yield* tasks.await([])
    yield* events.drain
    if ((yield* activity) !== before) yield* Effect.suspend(() => settle)
  })
  yield* settle
})

/** Record the reply (`persistReply`), drain the reactions to it, and flush the journal. */
export const finishTurn = (outcome: TurnOutcome): Effect.Effect<void, HarnessError, TurnMemory | TurnEvents | RunContext> => Effect.gen(function* () {
  yield* (yield* TurnMemory).persistReply(outcome)
  yield* (yield* TurnEvents).drain
  yield* (yield* RunContext).flush
})

/**
 * Run a turn's body to its end: once it succeeds, the turn settles (tasks
 * and background reactions) and finishes with its outcome. When it fails
 * or is interrupted, the turn finishes as failed and keeps the body's
 * cause. A HarnessError carried as a defect (a subscriber's failure behind
 * a `never` error channel) fails the turn, typed.
 */
export const guardTurn = <E, R>(body: Effect.Effect<TurnOutcome, E, R>): Effect.Effect<
  TurnOutcome,
  E | HarnessError,
  R | TurnMemory | TurnEvents | TurnTasks | RunContext
> => harnessDefectsAsFailures(body.pipe(Effect.tap(() => settleTurn))).pipe(
  Effect.onExit(Exit.match({
    onSuccess: () => Effect.void,
    // The turn already failed; recording that must not replace its cause.
    onFailure: () => finishTurn(failed).pipe(Effect.catchCause(() => Effect.void)),
  })),
  Effect.tap(finishTurn),
)

/**
 * The `Turn` a host's code works with, over the turn's services (the one
 * `Agent.turn` hands to `use`): its `run` is `runTurnLoop` with `options`.
 * The message must be persisted and the tools open.
 */
export const turnOf = (options: TurnRunOptions = {}): Effect.Effect<Turn, HarnessError, TurnRunServices | RunContext | StepLoop> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<TurnRunServices | StepLoop>()
    const run = yield* RunContext
    const memory = yield* TurnMemory
    return {
      conversation: run.conversation,
      runId: run.runId,
      turn: yield* memory.number,
      userMessage: run.userMessage,
      memory: run.memory,
      events: run.events,
      tasks: run.tasks,
      tools: yield* turnTools,
      context: memory.context,
      reply: (text) => Effect.succeed<TurnOutcome>({ outcome: "completed", reply: Option.some(text) }),
      loop: (policy) => runTurnLoop(policy, options).pipe(Effect.provide(services)),
      flush: run.flush,
      write: run.write,
    } satisfies Turn
  })
