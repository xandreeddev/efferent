import { Effect, Option, Predicate, Result, Schedule } from "effect"
import { currentFormat, Sessions, stored } from "@xandreed/core"
import type { InvalidSession, JournalStorageError, SessionHeader, SessionId, StoredEvent } from "@xandreed/core"
import { Curator } from "./curator.port.js"
import { curatedEvent, curationFailedEvent, DROPPED_SHOWN, KNOWLEDGE_OWNER, NOT_CURATED, sourceEvent, SourceState } from "./knowledge.entity.js"
import type { CurateOptions, CurationOutcome, NewSource, SourceData, SourceId } from "./knowledge.entity.js"
import { keptFrom, knowledgeOf, nextIds } from "./knowledge.entity.functions.js"
import { curationOf, draftsOf, staged } from "./knowledge-curation.entity.functions.js"
import { curationPrompt, reviewPrompt } from "./knowledge-prompt.entity.functions.js"
import { shownFor } from "./knowledge-shown.entity.functions.js"

/**
 * The knowledge session among a store's headers: the first by creation whose owner is `KNOWLEDGE_OWNER`, that
 * continues no other, and that this kernel reads. One written in another journal format is passed over, as the
 * facts' memory session is: old journals are not migrated.
 */
const knowledgeAmong = (headers: ReadonlyArray<SessionHeader>): Option.Option<SessionId> =>
  Option.map(
    Option.fromNullishOr(headers.find((header) => header.owner === KNOWLEDGE_OWNER && header.parent === undefined && Result.isSuccess(currentFormat(header)))),
    (header) => header.id,
  )

/**
 * The knowledge session (ADR 0022): the journal a curator's work is kept in. It is the first session, by creation,
 * whose owner is `KNOWLEDGE_OWNER`; with none in the store, one is created, and the store is listed again, so two
 * programs that each created one before either listed again both write to the first, as with the facts' memory
 * session. A host on a store that outlives its process recovers this session as it recovers its conversation.
 *
 * @public
 */
export const knowledgeSession: Effect.Effect<SessionId, InvalidSession | JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const found = knowledgeAmong(yield* sessions.list)
  if (Option.isSome(found)) return found.value
  const created = yield* sessions.create({ owner: KNOWLEDGE_OWNER })
  return Option.getOrElse(knowledgeAmong(yield* sessions.list), () => created)
})

/**
 * The knowledge session's journal, or none when the store holds no knowledge session: reading stores nothing, and no
 * session is created. What recall folds (`knowledgeOf`).
 *
 * @public
 */
export const knowledgeJournal: Effect.Effect<ReadonlyArray<StoredEvent>, JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  return yield* Option.match(knowledgeAmong(yield* sessions.list), {
    onNone: () => Effect.succeed<ReadonlyArray<StoredEvent>>([]),
    onSome: (id) => Effect.map(sessions.read(id), (journal) => journal.events),
  })
})

/** A refusal of a turn because another turn holds the session (`SessionBusy`). */
const isBusy = (error: unknown): boolean =>
  Predicate.isTagged(error, "SessionRefused") && Predicate.hasProperty(error, "reason") && error.reason === "SessionBusy"

/**
 * A turn of the knowledge session, waited for while another turn holds the session: every writer of it (a curation's
 * turns, a host's load, a tool's) holds it for a few appends, and a turn's end can still be being announced after its
 * body returned, so the step waits for it, every 25 ms for up to 10 seconds, rather than failing the curation. A session
 * still held then (a writer that died inside a turn, until the host recovers it) fails the step as it is. The wait is
 * interruptible; the turn, once begun, is as the caller made it.
 */
const whenFree = <A, E, R>(turn: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.retry(turn, { while: isBusy, times: 400, schedule: Schedule.spaced("25 millis") })

/**
 * One try at a stored source: the curator asked, the reply checked, and what passed stored with the record that the
 * source was curated; or, when a call fails or a reply holds no JSON object, the record that the try failed. The
 * model calls run outside any turn of the knowledge session, which takes one turn at a time.
 */
const curateStored = (session: SessionId, source: SourceData, attempt: number, options: CurateOptions) => Effect.gen(function* () {
  const sessions = yield* Sessions
  const curator = yield* Curator
  const prompts: Array<string> = []
  const replies: Array<string> = []
  const calls = () => ({ prompts: [...prompts], replies: [...replies] })
  /** A call to the curator, its prompt and its reply kept; a failed call is its reason. */
  const ask = (prompt: string, purpose: "extract" | "review") => {
    prompts.push(prompt)
    return curator.curate({ prompt, job: { source: source.id, attempt, purpose } }).pipe(
      Effect.map((reply): Result.Result<string, string> => {
        replies.push(reply)
        return Result.succeed(reply)
      }),
      Effect.catchTag("CurationFailed", (failed) => Effect.succeed<Result.Result<string, string>>(Result.fail(failed.message))),
    )
  }
  const failed = (reason: string) => Effect.as(
    whenFree(Effect.uninterruptible(sessions.turn(session, (open) => open.append(stored(curationFailedEvent, { source: source.id, attempt, reason }))))),
    { _tag: "Failed" as const, source, attempt, calls: calls(), reason },
  )
  // What the curator is shown is read from the knowledge as it stands now, the source stored.
  const shown = shownFor(knowledgeOf((yield* sessions.read(session)).events), source)
  const prompt = curationPrompt(source, shown, options.prompt ?? {})
  const first = yield* ask(prompt, "extract")
  if (Result.isFailure(first)) return yield* failed(first.failure)
  const proposal = curationOf(first.success)
  if (Option.isNone(proposal)) return yield* failed(NOT_CURATED.reply)
  let read = proposal.value
  if (options.review !== false) {
    const second = yield* ask(reviewPrompt(prompt, first.success), "review")
    if (Result.isFailure(second)) return yield* failed(second.failure)
    const reviewed = curationOf(second.success)
    if (Option.isNone(reviewed)) return yield* failed(NOT_CURATED.review)
    read = reviewed.value
  }
  const stage = staged(read.curation, source, shown)
  // What passed is stored in one turn, over the knowledge as it stands now: it may have moved while the model answered.
  // The turn is not cut short, so its records are never stored without the one that says the source was curated.
  const kept = yield* whenFree(Effect.uninterruptible(sessions.turn(session, (open) => Effect.gen(function* () {
    const drafts = draftsOf(stage, knowledgeOf(yield* open.journal), source)
    yield* Effect.forEach(drafts, (draft) => open.append(draft), { concurrency: 1, discard: true })
    yield* open.append(stored(curatedEvent, { source: source.id, calls: prompts.length, kept: drafts.length, dropped: stage.dropped.slice(0, DROPPED_SHOWN) }))
    return keptFrom(yield* open.journal, source.id)
  }))))
  const outcome: CurationOutcome = { _tag: "Curated", source, attempt, calls: calls(), shown, malformed: read.malformed, dropped: stage.dropped, kept }
  return outcome
})

/**
 * The curation step a host's program calls after a turn (ADR 0022, ADR 0023): `source` is stored first, in a turn of
 * `session` (the knowledge session, `knowledgeSession`), where it takes its id; the host's `Curator` is asked with the
 * kernel's prompt over what is stored about the entities the source names (`shownFor`, `curationPrompt`), and, unless
 * `options.review` is `false`, asked again to review its reply (`reviewPrompt`); the reply is read (`curationOf`) and
 * checked (`staged`), and what passed is stored in one turn (`draftsOf`) with `plugin.knowledge.curated`. When a call
 * fails (`CurationFailed`) or a reply holds no JSON object, `plugin.knowledge.failed` is stored with the try and the
 * reason, and nothing else: an unreadable review fails the try, since the reply it was asked to correct is what a
 * review exists to catch. The model calls run outside any turn of the knowledge session. Each of its turns waits while
 * another turn holds the session (`SessionBusy`), every 25 ms for up to 10 seconds, and fails as it is after that.
 *
 * It answers what came of it (`CurationOutcome`); a store or a session that fails is its failure. An interruption
 * stores neither record, so the source stays `Pending` and `curateAgain` can take it up; the turns that store the
 * records are not cut short once begun, so what a curation kept is never stored without its `plugin.knowledge.curated`.
 *
 * @public
 */
export const curate = Effect.fn("knowledge.curate")(function* (session: SessionId, source: NewSource, options: CurateOptions = {}) {
  const sessions = yield* Sessions
  const made = yield* whenFree(sessions.turn(session, (open) => Effect.gen(function* () {
    // The source's own fields, by name: a host's value may hold more (a `TurnSource`'s text), which is never stored.
    const data: SourceData = {
      id: nextIds(knowledgeOf(yield* open.journal)).source,
      said: source.said,
      at: source.at,
      ...(source.context === undefined ? {} : { context: source.context }),
      ...(source.from === undefined ? {} : { from: source.from }),
      ...(source.meta === undefined ? {} : { meta: source.meta }),
    }
    yield* open.append(stored(sourceEvent, data))
    return data
  })))
  return yield* curateStored(session, made, 1, options)
})

/**
 * The curation step for a source already stored that no curation kept (`Pending`, or `Failed`): a source whose
 * curation was cut short, or failed, or was never asked for after a restart. Its try is one more than those that
 * failed. None when the session holds no such source, or the source was curated.
 *
 * @public
 */
export const curateAgain = Effect.fn("knowledge.curate_again")(function* (session: SessionId, source: SourceId, options: CurateOptions = {}) {
  const sessions = yield* Sessions
  const known = knowledgeOf((yield* sessions.read(session)).events).sources.find((one) => one.source.id === source)
  const attempt = Option.flatMap(Option.fromNullishOr(known), (one) => SourceState.match(one.state, {
    Pending: () => Option.some(1),
    Curated: () => Option.none<number>(),
    Failed: ({ attempts }) => Option.some(attempts + 1),
  }))
  if (known === undefined || Option.isNone(attempt)) return Option.none<CurationOutcome>()
  return Option.some(yield* curateStored(session, known.source, attempt.value, options))
})
