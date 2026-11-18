// Lesson 18's Load the world: the page writes the world (world.ts) into the
// graph session as records, in one turn, the way linkThings would have stored
// each sentence, and never through a tool: a tool call per sentence would put
// 654 calls in the chat's journal. Each sentence is `plugin.graph.linked` the
// first time its three parts, normalised, are seen, and
// `plugin.graph.restated` after, with the id of the link it says again. Ids
// go on from the links the graph session ever stored (e10 after e1 to e9).
// Each sentence comes from a turn of its own of the world (`from`), so a
// sentence said twice is counted twice, and each record's time is the day
// its sentence was said: the journal stamps a record with the clock of the
// fiber that appends it, and each append is given a clock that reads that
// day.
import { Clock, Effect, Option, Result } from "effect"
import { dataOf, SessionId, Sessions, stored, TurnNumber } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { graphSession, LinkId, linkedEvent, linksOf, normalName, restatedEvent } from "@xandreed/sdk/kernel"
import { WORLD } from "./world.ts"
import type { WorldEntry } from "./world.ts"

/** The conversation every record of the world says it came from: no session has this id, and none is made for it. */
export const WORLD_SESSION = SessionId.make("world")

/** What Load the world says when the graph session holds the world already: a second load would count every sentence twice. */
export const LOADED_ALREADY = "The world is loaded already: the graph session holds its sentences, and a second load would count each one twice. A reload of the page empties the graph session."

/** A sentence's three parts as the graph tells links apart: each normalised. */
const keyOf = (subject: string, relation: string, object: string): string => [subject, relation, object].map(normalName).join("|")

/**
 * A clock that reads `at` (milliseconds) for the time of day, and is the live clock for everything else: how long
 * something takes, and a sleep. Each of the seven members is written out, so it is a `Clock` by its type alone.
 */
export const clockAt = (at: number, live: Clock.Clock): Clock.Clock => ({
  currentTimeMillisUnsafe: () => at,
  currentTimeMillis: Effect.succeed(at),
  currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
})

/** The day a sentence was said, as the time a record is stored at: midnight, UTC. */
export const dayOf = (said: string): number => Date.parse(`${said}T00:00:00Z`)

/** One record for each sentence of the world, against what the graph session holds already: a new link, or a link said again. */
export const worldDrafts = (journal: ReadonlyArray<StoredEvent>, world: ReadonlyArray<WorldEntry> = WORLD): ReadonlyArray<{ readonly draft: StoredDraft; readonly at: number; readonly isNew: boolean }> => {
  const known = new Map(linksOf(journal).map((link) => [keyOf(link.subject, link.relation, link.object), link.id]))
  let made = journal.filter((record) => Option.isSome(dataOf(linkedEvent, record))).length
  return world.map(([subject, relation, object, said], index) => {
    const key = keyOf(subject, relation, object)
    const from = { session: WORLD_SESSION, turn: TurnNumber.make(index + 1) }
    const again = known.get(key)
    if (again !== undefined) return { draft: stored(restatedEvent, { id: again, from }), at: dayOf(said), isNew: false }
    const id = LinkId.make(`e${++made}`)
    known.set(key, id)
    return { draft: stored(linkedEvent, { id, subject, relation, object, from }), at: dayOf(said), isNew: true }
  })
}

/** Whether the graph session holds the world already: a record of it names the world's conversation. */
const holdsWorld = (journal: ReadonlyArray<StoredEvent>): boolean =>
  journal.some((record) =>
    Option.exists(dataOf(linkedEvent, record), (link) => link.from.session === WORLD_SESSION) ||
    Option.exists(dataOf(restatedEvent, record), (again) => again.from.session === WORLD_SESSION))

/** What a load stored, in words. */
const storedWords = (made: ReadonlyArray<{ readonly isNew: boolean; readonly draft: StoredDraft }>, journal: ReadonlyArray<StoredEvent>): string => {
  const fresh = made.filter((one) => one.isNew).length
  const first = journal.filter((record) => Option.isSome(dataOf(linkedEvent, record))).length + 1
  return `Stored ${made.length} sentences in one turn on the graph session: ${fresh} new links, e${first} to e${first + fresh - 1}, and ${made.length - fresh} said again.`
}

/**
 * Load the world: every sentence of world.ts stored in the graph session, in one turn, each with its own `from` and
 * the day it was said as its time. It is refused, storing nothing, when the graph session holds the world already.
 * It gives what it stored in words, or why it stored nothing.
 */
export const loadWorld: Effect.Effect<string, string, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const graph = yield* graphSession
  // Read first, so a second load opens no turn; read again inside the turn, where nothing else writes.
  if (holdsWorld((yield* sessions.read(graph)).events)) return yield* Effect.fail(LOADED_ALREADY)
  const live = yield* Clock.Clock
  return yield* sessions.turn(graph, (session) => Effect.gen(function* () {
    const journal = yield* session.journal
    if (holdsWorld(journal)) return Result.fail(LOADED_ALREADY)
    const made = worldDrafts(journal)
    // Each record is stamped with the day its sentence was said: the append runs with a clock that reads that day.
    yield* Effect.forEach(made, ({ draft, at }) => session.append(draft).pipe(Effect.provideService(Clock.Clock, clockAt(at, live))), { concurrency: 1, discard: true })
    return Result.succeed(storedWords(made, journal))
  }))
}).pipe(
  Effect.flatMap(Effect.fromResult),
  Effect.catch((error) => Effect.fail(typeof error === "string" ? error : `The world could not be loaded: ${error.message}`)),
)
