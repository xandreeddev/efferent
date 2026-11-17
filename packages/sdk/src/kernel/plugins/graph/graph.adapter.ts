import { Effect, Layer, Option, Result, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { currentFormat, Sessions } from "@xandreed/core/kernel"
import type { InvalidSession, JournalStorageError, SessionHeader, SessionId, StoredEvent } from "@xandreed/core/kernel"
import { checkedOptions, followed, GRAPH_BUSY, linked, linkFrom, linksNote, linksOf, linkToUnlink, near, nextLinkId, restated, sameLink, saidIn, saidOf, unlinked, weightOf } from "../../contracts/graph/graph.entity.functions.js"
import { Followed, FOLLOW_LIMIT, FOLLOW_THINGS, GRAPH_OWNER, LINK_THINGS, LinkedThings, NAME_LIMIT, RELATION_LIMIT, UNLINK_THINGS } from "../../contracts/graph/graph.entity.js"
import type { GraphOptions, Link, SaidLink } from "../../contracts/graph/graph.entity.js"
import { questionOf } from "../../contracts/memory/memory.entity.functions.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import { CurrentTurn } from "../../contracts/turn/current-turn.port.js"

/**
 * The graph session among a store's headers: the first by creation that the plugin owns, that continues no other,
 * and that this kernel reads, as the memory session of facts is found (ADR 0014).
 */
const graphAmong = (headers: ReadonlyArray<SessionHeader>): Option.Option<SessionId> =>
  Option.map(
    Option.fromNullishOr(headers.find((header) => header.owner === GRAPH_OWNER && header.parent === undefined && Result.isSuccess(currentFormat(header)))),
    (header) => header.id,
  )

/**
 * The graph session (ADR 0019): the journal that holds an agent's links. It is the first session, by creation, that
 * the plugin owns; with none in the store, one is created and the store listed again, as `memorySession` does, under
 * the same one-writer assumption (ADR 0010).
 *
 * @public
 */
export const graphSession: Effect.Effect<SessionId, InvalidSession | JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const found = graphAmong(yield* sessions.list)
  if (Option.isSome(found)) return found.value
  const created = yield* sessions.create({ owner: GRAPH_OWNER })
  return Option.getOrElse(graphAmong(yield* sessions.list), () => created)
})

/**
 * The links that stand, read from the graph session, for a host that writes a wrapper of its own. With no graph
 * session there are none, and none is created: reading stores nothing.
 *
 * @public
 */
export const knownLinks: Effect.Effect<ReadonlyArray<Link>, JournalStorageError, Sessions> = Effect.suspend(() => Effect.map(graphJournal, linksOf))

/**
 * The links that stand, each with how many turns said it and when it was last said (`saidOf`), read from the graph
 * session: what a host draws or weighs links by. With no graph session there are none, and none is created.
 *
 * @public
 */
export const saidLinks: Effect.Effect<ReadonlyArray<SaidLink>, JournalStorageError, Sessions> = Effect.suspend(() => Effect.map(graphJournal, saidOf))

/** The graph session's journal, or none when there is no graph session: reading stores nothing. */
const graphJournal: Effect.Effect<ReadonlyArray<StoredEvent>, JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  return yield* Option.match(graphAmong(yield* sessions.list), {
    onNone: () => Effect.succeed<ReadonlyArray<StoredEvent>>([]),
    onSome: (id) => Effect.map(sessions.read(id), (journal) => journal.events),
  })
})

/**
 * The tool that stores a link between two things (ADR 0019). It stores the link in the graph session, a journal of
 * its own, and answers its id; a link that says what a standing one says is not stored again, and the standing
 * one's id is answered.
 *
 * @public
 */
export const LinkThings = Tool.make(LINK_THINGS, {
  description: "Store a link between two things the user told you about, for later conversations: a subject, how it relates, and an object, read as a sentence (\"Ana\", \"works at\", \"Acme\"). Call it once for each link. Returns the link's id.",
  parameters: Schema.Struct({
    subject: Schema.String.annotate({ description: `The thing the sentence is about, by a short name of at most ${NAME_LIMIT} characters, such as "Ana".` }),
    relation: Schema.String.annotate({ description: `How the subject relates to the object, in a few words of at most ${RELATION_LIMIT} characters, such as "works at".` }),
    object: Schema.String.annotate({ description: `The other thing, by a short name of at most ${NAME_LIMIT} characters, such as "Acme".` }),
  }),
  success: LinkedThings,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Sessions, CurrentTurn],
})

/**
 * The tool that removes a link (ADR 0019): it no longer stands, and is sent in no later request.
 *
 * @public
 */
export const UnlinkThings = Tool.make(UNLINK_THINGS, {
  description: "Remove a stored link, when the user asks you to or says it is no longer true. Returns what was removed.",
  parameters: Schema.Struct({ id: Schema.String.annotate({ description: "The link's id, as linkThings or followThings gave it, such as e1." }) }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Sessions, CurrentTurn],
})

/**
 * The tool that reads the links of one thing (ADR 0019), to follow a link further than a request was sent. It
 * stores nothing.
 *
 * @public
 */
export const FollowThings = Tool.make(FOLLOW_THINGS, {
  description: `Read the stored links that name a thing, as subject or as object, newest first: at most ${FOLLOW_LIMIT}, and how many more there are. Use it to find what a thing is linked to.`,
  parameters: Schema.Struct({ name: Schema.String.annotate({ description: "The thing's name, as a link writes it, such as \"Acme\"." }) }),
  success: Followed,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Sessions],
})

/**
 * The three tools of an agent whose memory connects: a host merges them into its own toolkit, `Toolkit.merge(tools,
 * graphTools)`, which keeps each tool's type.
 *
 * @public
 */
export const graphTools = Toolkit.make(LinkThings, UnlinkThings, FollowThings)

/** Whether a failure is the graph session being written to by another turn. */
const isBusy = (error: string | { readonly _tag: string; readonly reason?: string }): boolean =>
  typeof error !== "string" && error._tag === "SessionRefused" && error.reason === "SessionBusy"

/**
 * What a failed call says to the model: a refusal of the tool's own in its words, a graph session another turn is
 * writing to in fixed words; any other failure of the store or the session is a defect, as for facts.
 */
const said = (error: string | { readonly _tag: string; readonly reason?: string }): Effect.Effect<never, string> =>
  typeof error === "string" ? Effect.fail(error) : isBusy(error) ? Effect.fail(GRAPH_BUSY) : Effect.die(error)

/**
 * What the three tools do: each write is one turn on the graph session, which stores the record with the
 * conversation and turn it came from; `followThings` reads. Parts that make no link, an id no standing link has and
 * a graph session another turn is writing to are failed results the model reads; a store that fails is a defect.
 *
 * @public
 */
export const graphHandlers = graphTools.toLayer({
  linkThings: ({ subject, relation, object }) => Effect.gen(function* () {
    const sessions = yield* Sessions
    const caller = yield* CurrentTurn
    const parts = yield* Effect.fromResult(linkFrom(subject, relation, object))
    const from = { session: caller.id, turn: caller.turn }
    // A link this turn already said opens no turn: read first; read again inside the turn, where nothing else writes.
    const before = yield* graphJournal
    const standing = sameLink(linksOf(before), parts)
    if (Option.isSome(standing) && saidIn(before, standing.value.id, from)) return { id: standing.value.id }
    const written = sessions.turn(yield* graphSession, (session) => Effect.gen(function* () {
      const journal = yield* session.journal
      return yield* Option.match(sameLink(linksOf(journal), parts), {
        // Said again in another turn: how often a link was said is a record of its own, for a host that weighs links.
        onSome: (known) => (saidIn(journal, known.id, from) ? Effect.succeed({ id: known.id }) : Effect.as(session.append(restated({ id: known.id, from })), { id: known.id })),
        onNone: () => {
          const id = nextLinkId(journal)
          return Effect.as(session.append(linked({ id, ...parts, from })), { id })
        },
      })
    }))
    // A link that stands is answered by its id, whether or not its saying again could be stored: the graph session
    // busy with another turn costs the link one count, never the model its answer.
    return yield* Option.match(standing, {
      onNone: () => written,
      onSome: (known) => written.pipe(Effect.catch((error) => (isBusy(error) ? Effect.succeed({ id: known.id }) : Effect.fail(error)))),
    })
  }).pipe(Effect.catch(said)),
  unlinkThings: ({ id }) => Effect.gen(function* () {
    const sessions = yield* Sessions
    // Read first, so an id no link has opens no turn; read again inside the turn, where nothing else writes.
    yield* Effect.fromResult(linkToUnlink(yield* knownLinks, id))
    return yield* sessions.turn(yield* graphSession, (session) => Effect.gen(function* () {
      const link = yield* Effect.fromResult(linkToUnlink(linksOf(yield* session.journal), id))
      yield* session.append(unlinked(link.id))
      return `Removed ${link.id}: ${link.subject} ${link.relation} ${link.object}`
    }))
  }).pipe(Effect.catch(said)),
  followThings: ({ name }) => Effect.map(knownLinks, (links) => followed(links, name)).pipe(Effect.catch(said)),
})

/** A link's weight, from what was said of it; a link no record names (none, in a fold of the same journal) weighs 0. */
const weighing = (said: ReadonlyArray<SaidLink>, weights: NonNullable<GraphOptions["weights"]>) => {
  const byId = new Map(said.map((one) => [one.link.id, weightOf(one, weights)]))
  return (link: Link): number => byId.get(link.id) ?? 0
}

/**
 * A wrapper of `Memory` (ADR 0005, ADR 0019): for each request it reads the links that stand in the graph session
 * and adds up to `limit` of those near what the question names (`near`), last, after the context the memory below
 * returned. The question is the user's last message in the conversation's journal. Nothing is stored; with nothing
 * named, or no link near it, nothing is added. Options that are none are refused here, where they are written: it
 * throws, as a definition does.
 *
 * @public
 */
export const withGraph = (options: GraphOptions) => {
  const checked = Result.getOrThrowWith(checkedOptions(options), (problem) => new Error(problem))
  return <E, R>(memory: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R | Sessions> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const below = yield* Memory
      const sessions = yield* Sessions
      return Memory.of({
        context: Effect.fnUntraced(function* (session) {
          const context = yield* below.context(session)
          const journal = yield* Effect.provideService(graphJournal, Sessions, sessions)
          const weights = checked.weights
          const weigh = weights === undefined ? undefined : weighing(saidOf(journal), weights)
          const chosen = near(linksOf(journal), questionOf(yield* session.journal), { ...checked, ...(weigh === undefined ? {} : { weigh }) })
          return chosen.length === 0 ? context : [...context, { role: "user" as const, content: linksNote(chosen) }]
        }),
      })
    })).pipe(Layer.provide(memory))
}
