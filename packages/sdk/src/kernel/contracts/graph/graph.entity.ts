import { Option, Schema } from "effect"
import { liveEvent, SessionId, storedEvent, TurnNumber } from "@xandreed/core/kernel"

/**
 * A link's name: `e` and a number (`e3`), short enough for a model to write back. The graph session mints it, one
 * more than the number of links it ever stored, so no two links share one.
 *
 * @public
 */
export const LinkId = Schema.String.check(Schema.isPattern(/^e[1-9][0-9]{0,8}$/)).pipe(Schema.brand("LinkId"))
export type LinkId = typeof LinkId.Type

/**
 * The most characters of a thing's name. A name is a model's text, sent again in every later conversation that
 * names it: one that is longer is refused, in words the model reads, and never cut.
 *
 * @public
 */
export const NAME_LIMIT = 80

/**
 * The most characters of a relation, such as "works at".
 *
 * @public
 */
export const RELATION_LIMIT = 40

/** One line with no space at either end: no character that ends a line is in it. */
const oneLine = /^(?![^]*[\n\r\v\f\u0085\u2028\u2029])\S(?:[^]*\S)?$/

/**
 * A thing's name as a link holds it: one line of 1 to `NAME_LIMIT` characters, as the model wrote it. Two names are
 * one thing when they are the same once normalised (`normalName`): case and the spaces and marks between words do
 * not tell things apart.
 *
 * @public
 */
export const ThingName = Schema.String.check(Schema.isPattern(oneLine), Schema.isMaxLength(NAME_LIMIT))
export type ThingName = typeof ThingName.Type

/**
 * How a link's subject relates to its object: one line of 1 to `RELATION_LIMIT` characters ("works at", "is in").
 *
 * @public
 */
export const Relation = Schema.String.check(Schema.isPattern(oneLine), Schema.isMaxLength(RELATION_LIMIT))
export type Relation = typeof Relation.Type

/**
 * The data of `plugin.graph.linked`: a link between two things, read as a sentence, subject, relation, object ("Ana
 * works at Acme"), and the conversation and turn it was stored in.
 *
 * @public
 */
export const LinkedData = Schema.Struct({
  id: LinkId,
  subject: ThingName,
  relation: Relation,
  object: ThingName,
  from: Schema.Struct({ session: SessionId, turn: TurnNumber }),
})
export type LinkedData = typeof LinkedData.Type

/**
 * A link that stands: what `linksOf` gives. It is the data of the record that stored it.
 *
 * @public
 */
export type Link = LinkedData

/**
 * `plugin.graph.linked`: a link was stored (ADR 0019). Stored in the graph session, a journal of its own, tagged
 * `memory`. A reader of links that does not know it must not pass over it.
 *
 * @public
 */
export const linkedEvent = storedEvent("graph", "linked", { data: LinkedData, skippable: false, tags: ["memory"] })

/**
 * The data of `plugin.graph.restated`: a standing link said again, and the conversation and turn that said it.
 *
 * @public
 */
export const RestatedData = Schema.Struct({ id: LinkId, from: Schema.Struct({ session: SessionId, turn: TurnNumber }) })
export type RestatedData = typeof RestatedData.Type

/**
 * `plugin.graph.restated`: a link that stands was said again, in a turn that had not said it (ADR 0019, amended).
 * Stored in the graph session, tagged `memory`, skippable: a reader that does not know it reads the same links, only
 * without how often each was said.
 *
 * @public
 */
export const restatedEvent = storedEvent("graph", "restated", { data: RestatedData, skippable: true, tags: ["memory"] })

/**
 * A link that stands, with how often and when it was last said: `count` is how many turns said it (the one that
 * stored it, and each that said it again), `last` the time the latest of those records was stored, in milliseconds.
 * What `saidOf` gives.
 *
 * @public
 */
export interface SaidLink {
  readonly link: Link
  readonly count: number
  readonly last: number
}

/**
 * A thing a question names, how (`"words"`: a run of the question's words, accent marks aside; `"loose"`: a word one
 * letter away; `"speaker"`: one of the speaker's words), and the question's words that named it.
 *
 * @public
 */
export interface NamedThing {
  readonly thing: string
  readonly by: "words" | "loose" | "speaker"
  readonly words: ReadonlyArray<string>
}

/**
 * The walk `near` takes (`walked`): the things named, and every link reached, best first, each with the thing it was
 * reached from and the link the walk reached that thing by (none for a thing the question named), how many links
 * away, and the question's words its path met, in the question's order.
 *
 * @public
 */
export interface Walked {
  readonly named: ReadonlyArray<NamedThing>
  readonly reached: ReadonlyArray<{ readonly link: Link; readonly from: string; readonly via: Option.Option<LinkId>; readonly hops: number; readonly met: ReadonlyArray<string> }>
}

/**
 * How links are weighed, when a host asks for it: `"count"`, by how many turns said a link; or `{ halfLifeDays }`, by
 * that count with each link's weight halved for every `halfLifeDays` since it was last said, so an old link said
 * often can rank below a newer one said once. A weight ranks links that a question's words and the walk leave tied.
 *
 * @public
 */
export type Weights = "count" | { readonly halfLifeDays: number }

/**
 * The data of `plugin.graph.unlinked`: the link that no longer stands.
 *
 * @public
 */
export const UnlinkedData = Schema.Struct({ id: LinkId })
export type UnlinkedData = typeof UnlinkedData.Type

/**
 * `plugin.graph.unlinked`: a link no longer stands. Stored in the graph session, tagged `memory`, not skippable: a
 * reader that passed over it would go on sending a link that was removed.
 *
 * @public
 */
export const unlinkedEvent = storedEvent("graph", "unlinked", { data: UnlinkedData, skippable: false, tags: ["memory"] })

/**
 * The owner of the graph session: the journal that holds an agent's links.
 *
 * @public
 */
export const GRAPH_OWNER = "plugin.graph"

/**
 * The name of the tool that stores a link.
 *
 * @public
 */
export const LINK_THINGS = "linkThings"

/**
 * The name of the tool that removes a link.
 *
 * @public
 */
export const UNLINK_THINGS = "unlinkThings"

/**
 * The name of the tool that reads the links of one thing.
 *
 * @public
 */
export const FOLLOW_THINGS = "followThings"

/**
 * The most links `followThings` answers with; how many more there are is said.
 *
 * @public
 */
export const FOLLOW_LIMIT = 20

/**
 * What `linkThings` answers: the link's id, a new one or the one of the same link already stored.
 *
 * @public
 */
export const LinkedThings = Schema.Struct({ id: LinkId })
export type LinkedThings = typeof LinkedThings.Type

/**
 * A link as a tool answers it: its id and its sentence's three parts.
 *
 * @public
 */
export const LinkShown = Schema.Struct({ id: LinkId, subject: ThingName, relation: Relation, object: ThingName })
export type LinkShown = typeof LinkShown.Type

/**
 * What `followThings` answers: the links that name the thing, newest first, at most `FOLLOW_LIMIT`, and how many
 * more stand.
 *
 * @public
 */
export const Followed = Schema.Struct({ links: Schema.Array(LinkShown), more: Schema.Number })
export type Followed = typeof Followed.Type

/**
 * The person the agent talks with, as the graph names them: the node `name` stands for them, and a question that
 * holds one of `words` ("I", "me", "my" in English) names that node. The host gives both, in its own language: the
 * kernel holds no words of one.
 *
 * @public
 */
export interface Speaker {
  readonly name: string
  readonly words: ReadonlyArray<string>
}

/**
 * How a question names a thing (ADR 0019). `"exact"`: the thing's words are a run of the question's, as written.
 * `"loose"`: the same, with accent marks taken off both sides ("Joao" names "João"), and a word of five letters or
 * more naming a word one letter away that is five or more too ("Nowak" names "Novak", "Lisbon" names "Lisboa"); a
 * word holding a digit is never one letter away from another, so "QX-48213" names no other code.
 *
 * @public
 */
export type Naming = "exact" | "loose"

/**
 * The options of `withGraph`: how many links away from a thing the question names it walks (1 to 3), at most how
 * many links a request is sent (1 to 50), when the host gives one, the speaker, how a question names a thing
 * (`"exact"` unless given), and how links are weighed (not at all unless given).
 *
 * @public
 */
export interface GraphOptions {
  readonly hops: number
  readonly limit: number
  readonly speaker?: Speaker
  readonly names?: Naming
  readonly weights?: Weights
}

/**
 * The most links a `plugin.graph.recalled` event lists: at least twice the largest `limit`, so a link sent is never
 * left out of it; the rest it counts in `more`.
 *
 * @public
 */
export const RECALL_SHOWN = 100

/**
 * The most characters of the question a `plugin.graph.recalled` event repeats: an event is said for every model call,
 * and a client may forward `trace` events.
 *
 * @public
 */
export const QUESTION_SHOWN = 500

/**
 * The data of `plugin.graph.recalled`: what one request's walk did. The question (at most `QUESTION_SHOWN`
 * characters, what was cut counted); the options it ran with; the things the question named and how; and the links it
 * reached, best first (at most `RECALL_SHOWN`, the rest counted in `more`), each with the thing it was reached from
 * and the link that led there (`via`, null for a thing the question named), how many links away, the question's
 * words its path met, how many turns said it and when it was last said (in milliseconds), and whether the request
 * was sent it. Names are as the graph tells things apart (`normalName`), accent marks off when naming is loose.
 *
 * @public
 */
export const RecalledData = Schema.Struct({
  question: Schema.String,
  hops: Schema.Number,
  limit: Schema.Number,
  names: Schema.Literals(["exact", "loose"]),
  weights: Schema.NullOr(Schema.Union([Schema.Literal("count"), Schema.Struct({ halfLifeDays: Schema.Number })])),
  named: Schema.Array(Schema.Struct({ thing: Schema.String, by: Schema.Literals(["words", "loose", "speaker"]), words: Schema.Array(Schema.String) })),
  reached: Schema.Array(Schema.Struct({
    id: LinkId,
    subject: Schema.String,
    relation: Schema.String,
    object: Schema.String,
    from: Schema.String,
    via: Schema.NullOr(LinkId),
    hops: Schema.Number,
    met: Schema.Array(Schema.String),
    count: Schema.Number,
    last: Schema.Number,
    sent: Schema.Boolean,
  })),
  more: Schema.Number,
})
export type RecalledData = typeof RecalledData.Type

/**
 * `plugin.graph.recalled`: what `withGraph`'s walk did for one request (ADR 0019, amended), said live about the turn
 * and never stored, tagged `trace`. It is said for every model call the memory builds a context for, whether or not
 * the question named anything, so a client can show why a request was sent the links it was, or none.
 *
 * @public
 */
export const recalledEvent = liveEvent("graph", "recalled", { tags: ["trace"], data: RecalledData })
