import { Schema } from "effect"
import { SessionId, storedEvent, TurnNumber } from "@xandreed/core/kernel"

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
 * The options of `withGraph`: how many links away from a thing the question names it walks (1 to 3), at most how
 * many links a request is sent (1 to 50), and, when the host gives one, the speaker.
 *
 * @public
 */
export interface GraphOptions {
  readonly hops: number
  readonly limit: number
  readonly speaker?: Speaker
}
