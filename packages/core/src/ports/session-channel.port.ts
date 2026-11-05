import { Context } from "effect"
import type { Effect, Stream } from "effect"
import type { SessionChannelError, SessionChannelPayload } from "../session/session-channel.entity.js"
import type { SessionAddress } from "../session/sessions.entity.js"

/**
 * A session's live channel: what its followers see as it happens and the
 * journal never stores (a reply as it streams, a tool's output as it
 * arrives, a host's preview), shared by every request, tab or instance that
 * follows the session, whichever one runs its turn. Nothing is stored: a
 * follower reads the journal (`Sessions.read`) for what it missed.
 *
 * - `publish` hands a payload to every follower of that session subscribed
 *   at the time, and returns without waiting for any of them. With nobody
 *   following, it is dropped and nothing is kept.
 * - `subscribe` follows one session from its first pull on: the payloads
 *   published after that, in the order they were published, never one
 *   published before (no replay) and never another session's. A session is
 *   its whole address: the same id under another owner is another session.
 *   A follower that does not keep up keeps at most the adapter's capacity,
 *   the newest; the older ones are lost to it alone. The stream never ends
 *   by itself; ending it releases the follower, and the session's state is
 *   released with its last follower.
 * - Both fail with `SessionChannelError` only when the adapter's transport
 *   cannot be reached; a lost payload is not a failure.
 *
 * The channel does not authorize: the host checks that a follower may read
 * the session (as it does before `Sessions.read`) before subscribing it.
 * `sessionChannelConformance` (`@xandreed/core/conformance`) checks an
 * adapter; `SessionChannelMemoryLive` (`@xandreed/plugin-sessions`) is one
 * process's.
 *
 * @public
 */
export class SessionChannel extends Context.Service<SessionChannel, {
  readonly publish: (address: SessionAddress, payload: SessionChannelPayload) => Effect.Effect<void, SessionChannelError>
  readonly subscribe: (address: SessionAddress) => Stream.Stream<SessionChannelPayload, SessionChannelError>
}>()("@xandreed/core/SessionChannel") {}
