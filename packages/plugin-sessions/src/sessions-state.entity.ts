import { Schema } from "effect"
import { OpenTurn } from "@xandreed/core"

/*
 * The sessions plugin's own state, kept in the session head's `state` under
 * `sessions`: the turns begun, the open turn, the title and the inbox's
 * waiting items. It is a cache of the log (every change is committed with
 * the events that justify it), never read by a backend.
 */

/** One inbox item that is not done yet: waiting, or taken by an open turn. */
export const InboxSlot = Schema.Struct({
  id: Schema.String,
  /** Turns that took it and did not finish it. */
  attempts: Schema.Int,
  claimedBy: Schema.OptionFromNullOr(Schema.Int),
})
export type InboxSlot = typeof InboxSlot.Type

export const SessionsState = Schema.Struct({
  v: Schema.Literal(1),
  /** The highest turn number begun (a fork starts from its parent's). */
  turns: Schema.Int,
  open: Schema.OptionFromNullOr(OpenTurn),
  title: Schema.OptionFromNullOr(Schema.String),
  inbox: Schema.Array(InboxSlot),
})
export type SessionsState = typeof SessionsState.Type

/** How a session's turns are owned. */
export const Ownership = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("lease"),
    /** How long an open turn is held without a write (storage time). */
    ttlMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000)),
    /** `none`: the lease is fixed at begin; `on-commit`: each write extends it; `everyMs`: a keep-alive also extends it. */
    renew: Schema.Union([Schema.Literals(["none", "on-commit"]), Schema.Struct({ everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100)) })]),
  }),
  /** One process: turns are held by this process; a turn another process left open is interrupted. */
  Schema.Struct({ mode: Schema.Literal("process") }),
])
export type Ownership = typeof Ownership.Type

export const SessionsConfig = Schema.Struct({
  ownership: Ownership,
  /** The title is the first user message, cut to this many characters. */
  titleChars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  inbox: Schema.Struct({
    /** Items that may wait at once. */
    maxPending: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    /** Turns that may take an item and fail before it is dropped. */
    attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  }),
  /** The turn's write-behind queue: items before a writer waits, items taken per commit. */
  writer: Schema.Struct({
    capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
    batch: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  }),
  /** Compare-and-swap attempts before a write gives up as contended. */
  retries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
})
export type SessionsConfig = typeof SessionsConfig.Type

export const sessionsDefaults: SessionsConfig = {
  ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" },
  titleChars: 80,
  inbox: { maxPending: 20, attempts: 2 },
  writer: { capacity: 1_024, batch: 64 },
  retries: 8,
}
