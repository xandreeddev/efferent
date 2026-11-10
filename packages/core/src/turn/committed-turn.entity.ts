import { Schema } from "effect"
import { RunId } from "../domain/run.entity.js"
import { SessionRef } from "../session/session-log.entity.js"

/** A turn whose authoritative closing commit was acknowledged. @public */
export const CommittedTurn = Schema.Struct({
  session: SessionRef,
  runId: RunId,
  turn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type CommittedTurn = typeof CommittedTurn.Type

/** The bound for each optional committed-turn observer. @public */
export const COMMITTED_TURN_OBSERVER_TIMEOUT_MS = 1_000
