import { Schema } from "effect"

/**
 * The in-memory session channel's bound: the most live payloads a follower
 * that does not keep up keeps for its session (the newest; older ones are
 * lost to it alone).
 *
 * @public
 */
export const SessionChannelOptions = Schema.Struct({
  capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
})
export type SessionChannelOptions = typeof SessionChannelOptions.Type

/**
 * 256 payloads per followed session: a reply's deltas for a few seconds of
 * a follower that stalls.
 *
 * @public
 */
export const sessionChannelDefaults: SessionChannelOptions = { capacity: 256 }
