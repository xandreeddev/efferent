import { Context } from "effect"
import type { Effect } from "effect"
import type { TurnOrigin } from "../domain/turn-vocabulary.entity.js"
import type { JsonObject } from "../session/session-log.entity.js"
import type { SessionAddress, TurnRefused } from "../session/sessions.entity.js"

/** The turn a host is asked to admit. */
export interface TurnToAdmit {
  readonly session: SessionAddress
  readonly origin: TurnOrigin
  readonly runId: string
  readonly key: string
  /** The host's metadata the turn is begun with (`{}` when none was given): a tenant or a quota key to count by. */
  readonly meta: JsonObject
  /** The earlier turn a user's turn resumes (a whole number of at least 1), only when it resumes one. */
  readonly resumes?: number
}

/**
 * The host's say on every turn before it opens: a user's, the inbox's, a
 * background task's. `admit` runs around the one commit that opens the turn,
 * never around the turn's later writes, so a host can count and open in one
 * transaction; a duplicate, a key conflict, a busy session or a turn that
 * cannot be resumed (`NotResumable`) fails inside it and counts nothing. A
 * refusal opens nothing.
 */
export class TurnAdmission extends Context.Service<TurnAdmission, {
  readonly admit: <A, E>(turn: TurnToAdmit, open: Effect.Effect<A, E>) => Effect.Effect<A, E | TurnRefused>
}>()("efferent/TurnAdmission") {}
