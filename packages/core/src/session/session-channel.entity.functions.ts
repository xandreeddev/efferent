import { Cause, Duration, Effect, Fiber, Option, Queue, Schema, Stream } from "effect"
import { SessionChannel } from "../ports/session-channel.port.js"
import type { Subscription } from "../ports/turn-events.port.js"
import { TransientTurnEventName, TurnEvent } from "../turn/turn-event.entity.js"
import type { TurnEventOf } from "../turn/turn-event.entity.js"
import type { SessionChannelPayload } from "./session-channel.entity.js"
import { storedJson } from "./session-log.entity.functions.js"
import type { SessionAddress } from "./sessions.entity.js"

/**
 * Which transient events `shareTransient` sends, and how long it lets the
 * channel take them.
 *
 * @public
 */
export interface ShareTransientOptions {
  /** The transient events to share; every one (`TransientTurnEvents`) by default. */
  readonly events?: ReadonlyArray<TransientTurnEventName>
  /** How many payloads wait for the channel at most; past it the oldest waiting one is dropped. 256 by default. */
  readonly capacity?: number
  /** The longest one publish may take, in milliseconds, before its payload is dropped; also the most the turn's end waits for what is still waiting. 2000 by default. */
  readonly publishTimeoutMs?: number
}

const encodeEvent = Schema.encodeEffect(TurnEvent)
const isTransient = TurnEvent.isAnyOf(TransientTurnEventName.literals)

/** A transient event as a channel payload: its name, and its other fields as they encode, as JSON. */
const payloadOf = (event: TurnEventOf<TransientTurnEventName>): Effect.Effect<SessionChannelPayload, Schema.SchemaError> =>
  encodeEvent(event).pipe(
    Effect.flatMap(({ _tag, ...data }) => storedJson(data)),
    Effect.map((data) => ({ event: event._tag, data })),
  )

/**
 * Share a turn's transient events (`assistant.delta`, `tool.progress`, or
 * those `options.events` names) with every follower of its session: each
 * one goes to `SessionChannel.publish` for `address`, named as the event,
 * its other fields as data, in the order the turn published them. Attach it
 * to the turn's bus like any subscription
 * (`subscribeAll(turn.events, [shareTransient(address)])` in `use`), so a
 * feed opened by another request (a second tab, a reconnecting client, the
 * request that did not start a turn run in the background) shows the reply
 * as it streams. The journal is unchanged: a transient event is still never
 * stored, and a follower that subscribes later sees only what is published
 * from then on.
 *
 * Sharing never fails or holds the turn. The bus hands each payload to a
 * queue of `capacity` (the oldest waiting payload dropped when it is full)
 * without waiting, and one fiber of the subscription's scope publishes them
 * in order, each within `publishTimeoutMs`: a publish that fails or takes
 * longer is logged and its payload dropped, as transient payloads may be. As
 * the scope closes, what still waits is published within one more
 * `publishTimeoutMs`, then dropped. A host's own live payload (a preview, a
 * handshake) goes to the channel directly, with `publish`.
 *
 * @public
 */
export const shareTransient = (address: SessionAddress, options: ShareTransientOptions = {}): Subscription<SessionChannel> => {
  const chosen: ReadonlyArray<string> = options.events ?? TransientTurnEventName.literals
  const timeout = Duration.millis(options.publishTimeoutMs ?? 2_000)
  const select = (event: TurnEvent): Option.Option<TurnEventOf<TransientTurnEventName>> =>
    isTransient(event) && chosen.includes(event._tag) ? Option.some(event) : Option.none()
  return Effect.fnUntraced(function* (events) {
    const channel = yield* SessionChannel
    const waiting = yield* Queue.sliding<SessionChannelPayload, Cause.Done>(options.capacity ?? 256)
    const publish = (payload: SessionChannelPayload) => channel.publish(address, payload).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.logWarning(`a transient event was dropped: the session's channel did not take it within ${Duration.format(timeout)}`) }),
      Effect.ignore({ log: "Warn", message: "a transient event was not shared with the session's followers" }),
    )
    const sender = yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(waiting), publish))
    // Runs before the sender is interrupted: what still waits goes out, for one more timeout at most.
    yield* Effect.addFinalizer(() => Queue.end(waiting).pipe(
      Effect.andThen(Fiber.await(sender)),
      Effect.timeoutOption(timeout),
    ))
    yield* events.subscribe(select, (event) => payloadOf(event).pipe(
      Effect.flatMap((payload) => Queue.offer(waiting, payload)),
      Effect.ignore({ log: "Warn", message: "a transient event was not shared with the session's followers" }),
    ))
  })
}
