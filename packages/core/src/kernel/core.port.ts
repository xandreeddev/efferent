import { Context } from "effect"
import type { Effect, Schema, Scope, Stream } from "effect"
import type { Delivered, EventDefinition, KernelEvent, ListenerFailed } from "./event.entity.js"
import { PluginName } from "./ids.entity.js"

/**
 * How a listener takes part: in the background, or with the publisher waiting for it.
 *
 * @public
 */
export interface ListenOptions {
  /** The publisher waits for this listener, and fails if it fails. */
  readonly wait?: boolean
  /** The listener's name in a failure; the registering plugin's name when left out. */
  readonly name?: string
}

/**
 * The plugin whose setup is running: `definePlugin` sets it around a
 * plugin's `make`, and `Core.on` names a listener after it.
 *
 * @public
 */
export const CurrentPlugin = Context.Reference<PluginName>("@xandreed/core/kernel/CurrentPlugin", { defaultValue: () => PluginName.make("host") })

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
 */
export class Core extends Context.Service<Core, {
  /** Tell every listener; stores nothing. */
  readonly publish: (event: KernelEvent) => Effect.Effect<void, ListenerFailed>
  /**
   * React to the events of one definition, for as long as the scope it is
   * called in stays open. In the background by default: a failure there is
   * published as `core.listener.failed`. With `{ wait: true }` the
   * publisher waits, and the failure is the publisher's.
   */
  readonly on: <D extends Schema.Json, E>(
    event: EventDefinition<D>,
    handler: (event: Delivered<D>) => Effect.Effect<void, E>,
    options?: ListenOptions,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** Every event, live, from the moment the stream is run. */
  readonly events: Stream.Stream<KernelEvent>
}>()("@xandreed/core/kernel/Core") {}
