import { Effect, Layer, Option, PubSub, RcMap, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { SessionChannel } from "@xandreed/core"
import type { SessionAddress, SessionChannelPayload } from "@xandreed/core"
import { SessionChannelOptions, sessionChannelDefaults } from "./session-channel.entity.js"

/** A session's key: its id and its owner, so the same id under another owner is another session. */
const keyOf = (address: SessionAddress): string => JSON.stringify([address.id, address.owner])

/**
 * One process's session channel, and how many sessions it holds a hub for.
 * Per followed session, one hub, sliding at `capacity` (a follower that
 * falls behind keeps the newest payloads and never holds the publisher up),
 * held while someone follows the session (`RcMap` releases it with the last
 * follower). A publish to a session nobody follows finds no hub, keeps
 * nothing and is dropped. Nothing fails: no transport is involved.
 *
 * @public
 */
export const makeMemorySessionChannel = Effect.fnUntraced(function* (options: Partial<SessionChannelOptions> = {}): Effect.fn.Return<{
  readonly channel: SessionChannel["Service"]
  readonly retained: Effect.Effect<number>
}, never, Scope.Scope> {
  const { capacity } = yield* Schema.decodeUnknownEffect(SessionChannelOptions)({ ...sessionChannelDefaults, ...options }).pipe(Effect.orDie)
  const hubs = yield* RcMap.make({ lookup: (_: string) => Effect.acquireRelease(PubSub.sliding<SessionChannelPayload>(capacity), PubSub.shutdown) })
  const channel = SessionChannel.of({
    publish: (address, payload) => RcMap.getOption(hubs, keyOf(address)).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (hub) => PubSub.publish(hub, payload).pipe(Effect.asVoid) })),
      Effect.scoped,
    ),
    subscribe: (address) => Stream.unwrap(RcMap.get(hubs, keyOf(address)).pipe(Effect.map(Stream.fromPubSub))),
  })
  return { channel, retained: RcMap.keys(hubs).pipe(Effect.map((keys) => Array.from(keys).length)) }
})

/**
 * `SessionChannel` for one process: the live payloads of a session reach
 * every follower in this process, never another instance's (a host with
 * several instances provides an adapter over its own broker, proved by
 * `sessionChannelConformance`). Options merge over `sessionChannelDefaults`;
 * a capacity outside 1 to 65 536 is a defect when the layer is built.
 *
 * @public
 */
export const SessionChannelMemoryLive = (options: Partial<SessionChannelOptions> = {}): Layer.Layer<SessionChannel> =>
  Layer.effect(SessionChannel, makeMemorySessionChannel(options).pipe(Effect.map(({ channel }) => channel)))
