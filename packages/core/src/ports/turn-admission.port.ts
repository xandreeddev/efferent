import { Context } from "effect"
import type { Effect } from "effect"
import type { SessionAddress, TurnRefused } from "../session/sessions.entity.js"

/** The turn a host is asked to admit. */
export interface TurnToAdmit {
  readonly session: SessionAddress
  readonly origin: "user" | "inbox"
  readonly runId: string
  readonly key: string
}

/**
 * The host's say on every turn before it opens: a user's, the inbox's, a
 * background task's. `admit` runs around the one commit that opens the turn,
 * never around the turn's later writes, so a host can count and open in one
 * transaction; a duplicate or a busy session fails inside it and counts
 * nothing. A refusal opens nothing.
 */
export class TurnAdmission extends Context.Service<TurnAdmission, {
  readonly admit: <A, E>(turn: TurnToAdmit, open: Effect.Effect<A, E>) => Effect.Effect<A, E | TurnRefused>
}>()("efferent/TurnAdmission") {}
