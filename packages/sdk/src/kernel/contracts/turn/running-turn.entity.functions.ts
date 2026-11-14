import { Effect } from "effect"
import type { OpenSession } from "@xandreed/core/kernel"
import type { RunningTurn } from "./current-turn.port.js"

/**
 * An open session as the work of its turn holds it (`CurrentTurn`): the same
 * session, a failed read or write a defect of the work. Whoever hands the
 * turn over answers for that defect.
 */
export const runningTurn = (session: OpenSession): RunningTurn => ({
  id: session.id,
  turn: session.turn,
  journal: Effect.orDie(session.journal),
  append: (event) => Effect.orDie(session.append(event)),
  publish: (definition, data) => Effect.orDie(session.publish(definition, data)),
})
