import { Context } from "effect"
import type { Effect, Schema, Scope, Stream } from "effect"
import type { Delivered, EventDefinition, KernelEvent, ListenerFailed } from "./event.entity.js"

/**
 * How a listener takes part: its name, and whether the publisher waits for it.
 *
 * @public
 */
export interface ListenOptions {
  /** The listener's name, as a failure of it is reported: the plugin's own name, as a rule. */
  readonly name: string
  /** The publisher waits for this listener, and fails if it fails. */
  readonly wait?: boolean
}

/**
 * What a publisher may add to a publish.
 *
 * @public
 */
export interface PublishOptions {
  /**
   * A step of the publisher's own between the two halves of a publish: it
   * runs after the waiting listeners, whatever they did, and before the
   * event is handed to the background listeners and the stream. The session
   * plugin frees a session there, so whoever hears of a turn's end in the
   * background finds the session free.
   */
  readonly beforeHandOver?: Effect.Effect<void>
}

/**
 * Events, and nothing else: core stores nothing and runs no turn.
 *
 * `publish` first runs the listeners registered with `{ wait: true }`, in
 * the order they registered, one after another, and fails with
 * `ListenerFailed` when one fails; then it hands the event to the
 * background listeners and to `events`. A stored event reaches `publish`
 * after it is in the journal.
 *
 * Background delivery is bounded and sliding: a listener or a host that
 * reads slower than events arrive loses the oldest ones it has not read.
 * The journal is what is complete.
 *
 * `core.listener.failed` is never waited for: a listener registered on it
 * with `{ wait: true }` is delivered in the background like any other, so
 * the report of a failure cannot be held by a listener.
 *
 * A publisher waits for its waiting listeners for as long as it is not
 * interrupted itself. When it is, by its caller or by a limit put on the
 * publish, it returns at once, whether or not the listener can be
 * interrupted: the listener is reported as `core.listener.failed` and
 * interrupted behind it. The close of a listener's scope does not wait for
 * a call of the listener that is under way either. Whatever a handler ends
 * with is its own failure, an interrupt it was not sent included: only the
 * interruption of whoever waits cuts a listener short.
 */
export class Core extends Context.Service<Core, {
  /** Tell every listener; stores nothing. */
  readonly publish: (event: KernelEvent, options?: PublishOptions) => Effect.Effect<void, ListenerFailed>
  /**
   * React to the events of one definition, for as long as the scope it is
   * called in stays open: a plugin calls it in its layer's scope, so its
   * listeners go with the layer. The listener is registered before `on`
   * returns, so it misses nothing published after. In the background by
   * default: a failure there is published as `core.listener.failed`, under
   * the listener's `name`. With `{ wait: true }` the publisher waits, and
   * the failure is the publisher's; a listener whose scope closed while a
   * publish was under way is not run.
   */
  readonly on: <D extends Schema.Json, E>(
    event: EventDefinition<D>,
    handler: (event: Delivered<D>) => Effect.Effect<void, E>,
    options: ListenOptions,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** Every event, live, from the moment the stream is run. */
  readonly events: Stream.Stream<KernelEvent>
}>()("@xandreed/core/kernel/Core") {}
