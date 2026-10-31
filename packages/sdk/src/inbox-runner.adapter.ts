import { Context, Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import { InboxRunner, isTurnError, Sessions } from "@xandreed/core"
import type { Turn, TurnError, TurnOutcome, TurnRunner, TurnServices, TurnWriter } from "@xandreed/core"

/**
 * Execute a prebegun inbox or resumed turn through the agent. Build beside
 * the agent and provide the same Sessions that the drainer uses. Its captured
 * Sessions takes precedence over per-turn services. The caller owns the
 * writer's scope and end; this bridge only executes it.
 *
 * By default select skills for the admitted message, run the loop once, and
 * return its outcome and text. A custom use has Agent.turn's turn services.
 * @public
 */
export const agentInboxRunner = (agent: TurnRunner, options: {
  readonly services: Context.Context<never>
  readonly use?: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>
}): Layer.Layer<InboxRunner, never, Sessions> => Layer.effect(InboxRunner, Effect.gen(function* () {
  const sessions = yield* Sessions
  const services = Context.add(options.services, Sessions, sessions)
  const use = options.use ?? ((turn: Turn) => turn.tools.select(turn.userMessage).pipe(
    Effect.andThen(turn.run({})),
    Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
  ))
  return InboxRunner.of({
    run: Effect.fn("inbox_runner.run")((writer: TurnWriter) => agent.turn({ turn: writer, services }, use).pipe(
      Effect.catch((error) => isTurnError(error) ? Effect.fail(error) : Effect.die(error)),
      Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: result.reply })),
    )),
  })
}))
