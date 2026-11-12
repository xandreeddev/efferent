import { Cause, Option, Predicate, Schema } from "effect"
import type { AnnouncedEvent, EventDefinition, LiveDefinition, LiveEvent, StoredDefinition, StoredDraft, StoredEvent } from "./event.entity.js"
import { EventName, PluginName } from "./ids.entity.js"
import type { SessionId, TurnNumber } from "./ids.entity.js"
import type { Message } from "./message.entity.js"

const nameOf = (plugin: string, event: string): EventName => EventName.make(`plugin.${PluginName.make(plugin)}.${event}`)

/**
 * Define an event the journal keeps, named `plugin.<plugin>.<event>`. Its
 * data is plain JSON: a schema whose decoded value is its own encoding.
 * `skippable` says whether a reader that does not know the record may pass
 * over it.
 */
export const storedEvent = <D extends E, E extends Schema.Json>(
  plugin: string,
  event: string,
  spec: { readonly data: Schema.Codec<D, E>; readonly skippable: boolean },
): StoredDefinition<D> => ({ kind: "stored", name: nameOf(plugin, event), data: spec.data, skippable: spec.skippable })

/** Define an event that is published and never stored, named `plugin.<plugin>.<event>`. Its data is plain JSON. */
export const liveEvent = <D extends E, E extends Schema.Json>(
  plugin: string,
  event: string,
  spec: { readonly data: Schema.Codec<D, E> },
): LiveDefinition<D> => ({ kind: "live", name: nameOf(plugin, event), data: spec.data })

/**
 * An event of a stored definition, ready for `session.append`. A record that
 * bears a message names it here; anything more about it is in its data.
 */
export const stored = <D extends Schema.Json>(
  definition: StoredDefinition<D>,
  data: D,
  bears: { readonly message?: Message } = {},
): StoredDraft => ({ name: definition.name, data, skippable: definition.skippable, ...bears })

/** Where an event happened: a session and its open turn. An open session is one. */
interface TurnOrigin {
  readonly id: SessionId
  readonly turn: TurnNumber
}

/** What a live event is about: a session and, inside a turn, the turn. An open session is one; `{ id }` alone is a session and no turn of it. */
interface Origin {
  readonly id: SessionId
  readonly turn?: TurnNumber
}

/** An event of a live definition, ready for `core.publish`: about a turn when its origin names one, about the session alone when it does not. */
export const live = <D extends Schema.Json>(definition: LiveDefinition<D>, origin: Origin, data: D): LiveEvent =>
  ({ _tag: "Live", session: origin.id, ...(origin.turn === undefined ? {} : { turn: origin.turn }), name: definition.name, data })

/** A stored event as `Core` carries it: the same record, with its session and turn. Every stored event is stored inside a turn. */
export const announced = (origin: TurnOrigin, event: StoredEvent): AnnouncedEvent =>
  ({ _tag: "Stored", session: origin.id, turn: origin.turn, ...event })

/** The session and turn an event is about, as the origin of another: a listener publishes its own event about the one it received. */
export const originOf = (event: { readonly session: SessionId; readonly turn?: TurnNumber }): Origin =>
  ({ id: event.session, ...(event.turn === undefined ? {} : { turn: event.turn }) })

/** The data of an event, read as `definition` describes it; none when the event is not one of that definition. */
export const dataOf = <D extends Schema.Json>(definition: EventDefinition<D>, event: { readonly name: EventName; readonly data: Schema.Json }): Option.Option<D> =>
  event.name === definition.name ? Schema.decodeUnknownOption(definition.data)(event.data) : Option.none()

/** A failure as an event words it: its tag, then its message. No stack. */
export const reasonOf = (cause: Cause.Cause<unknown>): string =>
  Cause.hasInterruptsOnly(cause) ? "interrupted" : Option.match(Cause.findErrorOption(cause), {
    onNone: () => "defect",
    onSome: (error) => [
      ...(Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? [error._tag] : []),
      ...(Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? [error.message] : []),
    ].join(": "),
  })
