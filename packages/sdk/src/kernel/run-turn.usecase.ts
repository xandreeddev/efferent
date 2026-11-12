import { Effect } from "effect"
import { turnStarted, userMessage } from "@xandreed/core/kernel"
import type { Agent, TurnInput } from "@xandreed/core/kernel"
import { endTurn, record } from "./run-turn.usecase.functions.js"

/**
 * One turn of a session: the frame that opens the session, records the
 * turn's start and the user's message, runs the agent's step loop over the
 * context its manager opens, and always ends the turn, whatever the loop did.
 *
 * @public
 */
export const runTurn = (agent: Agent, input: TurnInput) =>
  Effect.acquireUseRelease(
    agent.sessions.open(input.session),                   // Sessions port: Free → TurnOpen, or SessionBusy
    (session) => Effect.gen(function* () {
      yield* record(agent, session, turnStarted(input))
      yield* record(agent, session, userMessage(input.message))
      const context = yield* agent.context.open(session)  // ContextManager port
      return yield* agent.loop(agent, session, context)   // the step loop part; returns the reply
    }),
    (session, exit) => endTurn(agent, session, exit),     // always runs: record core.turn.ended, TurnOpen → Free
  )
