import { Cause, Option, Predicate, Result, Schema } from "effect"
import { RESERVED_TAGS, Tag, TAG_SHAPE } from "./event.entity.js"
import type { AnnouncedEvent, DefinitionTag, EventDefinition, LiveDefinition, LiveEvent, ReservedTag, StoredDefinition, StoredDraft, StoredEvent } from "./event.entity.js"
import { EventName, PluginName } from "./ids.entity.js"
import type { SessionId, TurnNumber } from "./ids.entity.js"
import type { Message } from "./message.entity.js"

/**
 * Refuse a mistake where a definition is made, at load, with what is wrong in the error's message: a definition is
 * code, so its mistake is the programmer's, found the first time the module runs.
 */
const orRefuse = <A>(checked: Result.Result<A, string>): A => Result.getOrThrowWith(checked, (problem) => new Error(problem))

const isPluginName = Schema.is(PluginName)
const isEventName = Schema.is(EventName)

/** The name of a plugin's event, `plugin.<plugin>.<event>`; a plugin or an event that cannot be named so is refused, in words. */
const nameOf = (plugin: string, event: string): EventName => orRefuse(
  !isPluginName(plugin) ? Result.fail(`"${plugin}" is not a plugin's name: lowercase letters, digits and hyphens, starting with a letter or a digit`)
    : !isEventName(`plugin.${plugin}.${event}`) ? Result.fail(`"${event}" is not an event's name: words of lowercase letters, digits and hyphens, joined by dots`)
      : Result.succeed(EventName.make(`plugin.${plugin}.${event}`)),
)

const reserved: ReadonlyArray<string> = RESERVED_TAGS

/**
 * A tag as a definition may declare it: a reserved word, or `<plugin>.<tag>` under the definition's own plugin
 * (core's definitions have none, and declare reserved words only).
 */
const declaredTag = (plugin: Option.Option<string>) => (tag: string): Result.Result<Tag, string> => {
  if (!TAG_SHAPE.test(tag)) return Result.fail(`"${tag}" is not a tag: a tag is one of ${reserved.join(", ")}, or a plugin's own, "<plugin>.<tag>"`)
  if (!tag.includes(".")) return reserved.includes(tag) ? Result.succeed(Tag.make(tag)) : Result.fail(`"${tag}" is not a tag: the reserved ones are ${reserved.join(", ")}, and a plugin's own is "<plugin>.<tag>"`)
  return Option.match(plugin, {
    onNone: () => Result.fail(`"${tag}" is a plugin's tag, and this definition is core's`),
    onSome: (name) => tag.startsWith(`${name}.`) ? Result.succeed(Tag.make(tag)) : Result.fail(`"${tag}" is not this plugin's tag: the tags of plugin "${name}" start with "${name}."`),
  })
}

/**
 * A definition's tags, checked once where it is defined: a word that is not
 * reserved (a misspelt `conversation`), or another plugin's tag, throws
 * there, at load, with what is wrong, so a wrong tag never reaches a record.
 */
export const tagsOf = (tags: ReadonlyArray<DefinitionTag>, plugin?: string): ReadonlyArray<Tag> => {
  const declared = declaredTag(Option.fromNullishOr(plugin))
  return tags.map((tag) => orRefuse(declared(tag)))
}

/** The mark of a definition this module made: a key every copy of the kernel shares, on a property no copy carries over. */
const DEFINED = Symbol.for("@xandreed/core/kernel/EventDefinition")

/** Mark a definition as made here: `stored` makes a record only from such a definition. */
const defined = <Definition extends EventDefinition<Schema.Json>>(definition: Definition): Definition => {
  Object.defineProperty(definition, DEFINED, { value: true })
  return definition
}

/**
 * Define one of core's own stored events, under the name it is given in
 * full (`core.` or `conversation.`). Core's alone to call: it is not part
 * of the kernel's entry, and a plugin defines its own with `storedEvent`.
 */
export const coreStoredEvent = <D extends E, E extends Schema.Json>(
  name: string,
  spec: { readonly data: Schema.Codec<D, E>; readonly skippable: boolean; readonly tags: ReadonlyArray<ReservedTag> },
): StoredDefinition<D> => defined({ kind: "stored", name: EventName.make(name), data: spec.data, skippable: spec.skippable, tags: tagsOf(spec.tags) })

/** Define one of core's own live events, under the name it is given in full. Core's alone to call. */
export const coreLiveEvent = <D extends E, E extends Schema.Json>(
  name: string,
  spec: { readonly data: Schema.Codec<D, E>; readonly tags: ReadonlyArray<ReservedTag> },
): LiveDefinition<D> => defined({ kind: "live", name: EventName.make(name), data: spec.data, tags: tagsOf(spec.tags) })

/**
 * Define an event the journal keeps, named `plugin.<plugin>.<event>`. Its
 * data is plain JSON: a schema whose decoded value is its own encoding.
 * `skippable` says whether a part that reads the journal and does not know
 * the record may pass over it; `tags` say what it is for (`Tag`). This is
 * the one way to make a stored definition: `stored` makes a record only
 * from a definition made here.
 */
export const storedEvent = <D extends E, E extends Schema.Json>(
  plugin: string,
  event: string,
  spec: { readonly data: Schema.Codec<D, E>; readonly skippable: boolean; readonly tags: ReadonlyArray<DefinitionTag> },
): StoredDefinition<D> => defined({ kind: "stored", name: nameOf(plugin, event), data: spec.data, skippable: spec.skippable, tags: tagsOf(spec.tags, plugin) })

/** Define an event that is published and never stored, named `plugin.<plugin>.<event>`. Its data is plain JSON; `tags` say what it is for. */
export const liveEvent = <D extends E, E extends Schema.Json>(
  plugin: string,
  event: string,
  spec: { readonly data: Schema.Codec<D, E>; readonly tags: ReadonlyArray<DefinitionTag> },
): LiveDefinition<D> => defined({ kind: "live", name: nameOf(plugin, event), data: spec.data, tags: tagsOf(spec.tags, plugin) })

/** The mark of a draft `stored` made: a key every copy of the kernel shares, on a property no copy or store carries over. */
const MADE = Symbol.for("@xandreed/core/kernel/StoredDraft")

/**
 * An event of a stored definition, ready for `session.append`, with the
 * definition's name, tags and skip flag. A record that bears a message names
 * it here; anything more about it is in its data. This is the one way to
 * make a draft, and it makes one only from a definition `storedEvent` made:
 * a session refuses an object built by hand, a copy of a draft with a field
 * changed, and what this returns for a definition written by hand.
 */
export const stored = <D extends Schema.Json>(
  definition: StoredDefinition<D>,
  data: D,
  bears: { readonly message?: Message } = {},
): StoredDraft => {
  const draft: Omit<StoredEvent, "seq" | "at" | "turn"> = { name: definition.name, data, skippable: definition.skippable, tags: definition.tags, ...bears }
  if (Predicate.hasProperty(definition, DEFINED)) Object.defineProperty(draft, MADE, { value: true })
  return draft as StoredDraft
}

/**
 * Whether `value` is a draft `stored` made from a definition `storedEvent` made, and not an object built by hand, a
 * copy of one, or a record of a definition written by hand: what a session plugin checks before it stores a record.
 */
export const isStoredDraft = (value: unknown): value is StoredDraft => Predicate.hasProperty(value, MADE)

/**
 * Whether a record or a live event carries `tag`: how a reader takes only what it rebuilds from.
 *
 * @public
 */
export const taggedWith = (tag: string) => (event: { readonly tags: ReadonlyArray<Tag> }): boolean => event.tags.some((own) => own === tag)

/** What a live event is about: a session and, inside a turn, the turn. An open session is one; `{ id }` alone is a session and no turn of it. */
interface Origin {
  readonly id: SessionId
  readonly turn?: TurnNumber
}

/** An event of a live definition, ready for `core.publish`: about a turn when its origin names one, about the session alone when it does not. */
export const live = <D extends Schema.Json>(definition: LiveDefinition<D>, origin: Origin, data: D): LiveEvent =>
  ({ _tag: "Live", session: origin.id, ...(origin.turn === undefined ? {} : { turn: origin.turn }), name: definition.name, tags: definition.tags, data })

/** A stored event as `Core` carries it: the same record, with its session. Every stored event is stored inside a turn, which it names. */
export const announced = (origin: { readonly id: SessionId }, event: StoredEvent): AnnouncedEvent =>
  ({ _tag: "Stored", session: origin.id, ...event })

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
