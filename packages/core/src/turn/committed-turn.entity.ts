import { Schema } from "effect"
import { RunId } from "../domain/run.entity.js"
import { SessionAddress } from "../session/sessions.entity.js"

/** A turn whose authoritative closing commit was acknowledged. @public */
export const CommittedTurn = Schema.Struct({
  session: SessionAddress,
  runId: RunId,
  turn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type CommittedTurn = typeof CommittedTurn.Type

/** The bound for each optional committed-turn observer. @public */
export const COMMITTED_TURN_OBSERVER_TIMEOUT_MS = 1_000
