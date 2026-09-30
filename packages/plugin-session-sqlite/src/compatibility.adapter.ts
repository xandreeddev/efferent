import { Clock, Effect, Layer, Option, Random, Schema } from "effect"
import { ConversationId, HarnessError, SessionEvent, SessionLog, SessionRecord, SessionStore } from "@xandreed/core"
import type { EventBody, SessionCommitted, SessionDraft, SessionHead, SessionLogEvent } from "@xandreed/core"

type Log = SessionLog["Service"]

const storageFailure = (error: { readonly _tag: string; readonly message?: string }) => new HarnessError({ code: error._tag === "SessionMissing" ? "session.missing" : "session.log", message: error.message ?? error._tag })
const eventOf = Schema.decodeUnknownEffect(SessionEvent)
const decodeFailure = (error: unknown) => new HarnessError({ code: "session.decode", message: String(error) })
const HARNESS = "harness.event"

/** A harness record's own position (its harness seq); a malformed one sorts last, so its decoding fails where it is read. */
const harnessSeqOf = (event: SessionLogEvent): number => {
  const inner = event.data.event
  return typeof inner === "object" && inner !== null && "seq" in inner && typeof inner.seq === "number" ? inner.seq : Number.POSITIVE_INFINITY
}

/** Read inherited records at their immutable fork boundary, then the child's own records. */
export const compatibilityHistory = (log: Log, id: ConversationId, kinds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => Effect.gen(function* () {
  const head = yield* log.head(id).pipe(Effect.mapError(storageFailure))
  const inherited = yield* Option.match(head.header.parent, {
    onNone: () => Effect.succeed<ReadonlyArray<SessionLogEvent>>([]),
    onSome: (parent) => compatibilityHistory(log, parent.id, kinds).pipe(Effect.map((events) => events.filter((event) => event.session !== parent.id || event.seq <= parent.through))),
  })
  const own = yield* log.read(id, { after: 0, limit: Option.none(), kinds }).pipe(Effect.mapError(storageFailure))
  return [...inherited, ...own]
})

/** The first event of `kinds` after the cursor, when it is at or before `upTo`. */
const nextOf = (log: Log, id: ConversationId, kinds: ReadonlyArray<string>, after: number, upTo: number) =>
  log.read(id, { after, limit: Option.some(1), kinds }).pipe(
    Effect.map((events) => Option.filter(Option.fromNullishOr(events[0]), (event) => event.seq <= upTo)),
    Effect.mapError(storageFailure),
  )

/** The smallest cursor in [low, high] where the monotone `holds` is true, given that it holds at `high`. */
const firstHolding = (low: number, high: number, holds: (cursor: number) => Effect.Effect<boolean, HarnessError>): Effect.Effect<number, HarnessError> =>
  low >= high ? Effect.succeed(high) : Effect.gen(function* () {
    const middle = Math.floor((low + high) / 2)
    return (yield* holds(middle)) ? yield* firstHolding(low, middle, holds) : yield* firstHolding(middle + 1, high, holds)
  })

/**
 * The last event of `kinds` at or before `upTo` (the head when omitted), or
 * the inherited history's when the session has none of its own: a binary
 * search over the cursor, so an append never reads the whole history.
 */
export const compatibilityLast = (log: Log, id: ConversationId, kinds: ReadonlyArray<string>, upTo = Number.MAX_SAFE_INTEGER): Effect.Effect<Option.Option<SessionLogEvent>, HarnessError> => Effect.gen(function* () {
  const head = yield* log.head(id).pipe(Effect.mapError(storageFailure))
  const bound = Math.min(head.seq, upTo)
  // The smallest cursor with nothing of `kinds` after it is the last one's seq.
  const cursor = yield* firstHolding(0, bound, (at) => nextOf(log, id, kinds, at, bound).pipe(Effect.map(Option.isNone)))
  if (cursor > 0) return yield* nextOf(log, id, kinds, cursor - 1, bound)
  return yield* Option.match(head.header.parent, {
    onNone: () => Effect.succeed(Option.none<SessionLogEvent>()),
    onSome: (parent) => compatibilityLast(log, parent.id, kinds, parent.through),
  })
})

/**
 * The harness records after harness seq `after`, a fork's inherited ones
 * first. Harness seqs rise with the log's, so the own tail is found by a
 * binary search and read with the log's cursor: an incremental read costs
 * what it returns, not the history.
 */
const harnessAfter = (log: Log, id: ConversationId, after: number, upTo = Number.MAX_SAFE_INTEGER): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => Effect.gen(function* () {
  const head = yield* log.head(id).pipe(Effect.mapError(storageFailure))
  const bound = Math.min(head.seq, upTo)
  const beyond = (cursor: number) => nextOf(log, id, [HARNESS], cursor, bound).pipe(Effect.map(Option.match({ onNone: () => true, onSome: (event) => harnessSeqOf(event) > after })))
  const cursor = after < 0 || (yield* beyond(0)) ? 0 : yield* firstHolding(1, bound, beyond)
  const own = (yield* log.read(id, { after: cursor, limit: Option.none(), kinds: [HARNESS] }).pipe(Effect.mapError(storageFailure)))
    .filter((event) => event.seq <= bound && harnessSeqOf(event) > after)
  // An own record at or before `after` means every inherited one is too.
  const inherited = cursor > 0 ? [] : yield* Option.match(head.header.parent, {
    onNone: () => Effect.succeed<ReadonlyArray<SessionLogEvent>>([]),
    onSome: (parent) => harnessAfter(log, parent.id, after, parent.through),
  })
  return [...inherited, ...own]
})

/**
 * Plan against the head's revision; a conflict re-reads and re-plans. The
 * first retries are immediate, later ones wait a little (jittered), so an
 * append outside a turn outlasts a busy turn writer instead of failing.
 */
export const compatibilityCommit = <A>(log: Log, id: ConversationId, plan: (head: SessionHead) => Effect.Effect<{ readonly drafts: ReadonlyArray<SessionDraft>; readonly result: A }, HarnessError>): Effect.Effect<{ readonly committed: SessionCommitted; readonly result: A }, HarnessError> => {
  const attempt = (tries: number): Effect.Effect<{ readonly committed: SessionCommitted; readonly result: A }, HarnessError> => Effect.gen(function* () {
    const head = yield* log.head(id).pipe(Effect.mapError(storageFailure))
    const planned = yield* plan(head)
    return yield* log.commit(id, { expect: head.revision, notAfter: Option.none(), state: Option.none(), events: planned.drafts }).pipe(
      Effect.map((committed) => ({ committed, result: planned.result })),
      Effect.catchTag("RevisionConflict", (conflict) => tries >= 32 ? Effect.fail(storageFailure(conflict))
        : tries < 4 ? attempt(tries + 1)
        : Random.nextIntBetween(1, Math.min(2 ** (tries - 3), 50)).pipe(Effect.flatMap((wait) => Effect.sleep(`${wait} millis`)), Effect.andThen(attempt(tries + 1)))),
      Effect.mapError((error) => error instanceof HarnessError ? error : storageFailure(error)),
    )
  })
  return attempt(0)
}

/** Includes branches, preserving the historical list contract. */
export const compatibilityListing = (log: Log, owner: string, parent = Option.none<ConversationId>()): Effect.Effect<ReadonlyArray<SessionHead>, HarnessError> => Effect.gen(function* () {
  const heads = yield* log.list({ owner, limit: Number.MAX_SAFE_INTEGER, before: Option.none(), parent }).pipe(Effect.mapError(storageFailure))
  const children = yield* Effect.forEach(heads, (head) => compatibilityListing(log, owner, Option.some(head.header.id)))
  return [...heads, ...children.flat()].sort((a, b) => b.header.createdAt - a.header.createdAt)
})

const recordOf = (head: SessionHead) => Schema.decodeUnknownEffect(SessionRecord)({
  id: head.header.id, workspace: head.header.owner, profile: head.header.meta.profile ?? "smith", createdAt: head.header.createdAt,
  ...Option.match(head.header.parent, { onNone: () => typeof head.header.meta.legacyParent === "string" ? { parent: head.header.meta.legacyParent } : {}, onSome: (parent) => ({ parent: parent.id }) }),
}).pipe(Effect.mapError((error) => new HarnessError({ code: "session.decode", message: String(error) })))

const decodedHarness = (id: ConversationId, events: ReadonlyArray<SessionLogEvent>) =>
  Effect.forEach(events, (event) => eventOf(event.data.event).pipe(Effect.map((decoded) => ({ ...decoded, sessionId: id })), Effect.mapError(decodeFailure)))

export const harnessHistory = (log: Log, id: ConversationId, after = -1): Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError> =>
  harnessAfter(log, id, after).pipe(Effect.flatMap((events) => decodedHarness(id, events)))

export const harnessEvent = (id: ConversationId, body: EventBody, seq: number, at: number): SessionEvent => ({ ...body, version: 1, id: crypto.randomUUID(), sessionId: id, seq, at })

/**
 * @deprecated Historical harness vocabulary projected over SessionLog.
 * It owns no tables and can be removed once custom AgentLoop hosts use the
 * composable Agent/Turn API. Harness itself admits and ends through Sessions.
 */
export const SessionStoreProjectionLive = Layer.effect(SessionStore, Effect.gen(function* () {
  const log = yield* SessionLog
  return SessionStore.of({
    create: (workspace, profile) => Clock.currentTimeMillis.pipe(Effect.flatMap((createdAt) => log.create({
      id: ConversationId.make(crypto.randomUUID()), owner: workspace, origin: "harness", createdAt, meta: { workspace, profile, projection: "harness" }, parent: Option.none(),
    })), Effect.flatMap(recordOf), Effect.mapError((error) => error instanceof HarnessError ? error : storageFailure(error))),
    get: (id) => log.head(id).pipe(Effect.mapError(storageFailure), Effect.flatMap(recordOf)),
    list: (workspace) => compatibilityListing(log, workspace).pipe(Effect.flatMap((heads) => Effect.forEach(heads.filter((head) => head.header.origin !== "task"), recordOf))),
    read: (id, after) => harnessHistory(log, id, after),
    append: (id, body) => compatibilityCommit(log, id, (head) => Effect.gen(function* () {
      const last = yield* compatibilityLast(log, id, [HARNESS], head.seq)
      const previous = yield* Option.match(last, {
        onNone: () => Effect.succeed(-1),
        onSome: (event) => eventOf(event.data.event).pipe(Effect.map((decoded) => decoded.seq), Effect.mapError(decodeFailure)),
      })
      const event = harnessEvent(id, body, previous + 1, yield* Clock.currentTimeMillis)
      return { drafts: [{ kind: HARNESS, turn: Option.none(), data: { event } }], result: event }
    })).pipe(Effect.map((done) => done.result)),
    fork: (id, through) => Effect.gen(function* () {
      const parent = yield* log.head(id).pipe(Effect.mapError(storageFailure))
      const events = (yield* harnessHistory(log, id)).filter((event) => event.seq <= through)
      const open = events.reduce((runs, event) => event.runId === undefined ? runs : event.name === "run.started" ? [...runs, event.runId]
        : ["run.completed", "run.failed", "run.cancelled"].includes(event.name) ? runs.filter((run) => run !== event.runId) : runs, [] as ReadonlyArray<string>)
      if (open.length > 0) return yield* Effect.fail(new HarnessError({ code: "session.fork-boundary", message: "Fork at a settled turn boundary" }))
      const journal = yield* compatibilityHistory(log, id, [])
      const selected = journal.filter((event) => event.kind === "harness.event" && typeof event.data.event === "object" && event.data.event !== null && "seq" in event.data.event && typeof event.data.event.seq === "number" && event.data.event.seq <= through)
      const selectedLast = selected.at(-1)
      const selectedEnd = selectedLast === undefined ? undefined : journal.find((event) => event.session === selectedLast.session && event.kind === "turn.ended" && event.seq > selectedLast.seq && Option.isSome(selectedLast.turn) && Option.contains(event.turn, selectedLast.turn.value))
      const cut = selectedEnd?.seq ?? selectedLast?.seq ?? 0
      const inheritedCut = selectedLast !== undefined && selectedLast.session !== id
      const boundaryIndex = selectedLast === undefined ? -1 : journal.indexOf(selectedEnd ?? selectedLast)
      const copied = inheritedCut ? journal.slice(0, boundaryIndex + 1).filter((event) => event.kind === "harness.event" || event.kind.startsWith("conversation.")) : []
      const endings = journal.filter((event) => event.kind === "turn.ended" && event.seq <= cut)
      const created = yield* log.create({
        id: ConversationId.make(crypto.randomUUID()), owner: parent.header.owner, origin: parent.header.origin,
        createdAt: yield* Clock.currentTimeMillis, meta: { ...parent.header.meta, legacyParent: id },
        parent: inheritedCut ? Option.none() : Option.some({ id, through: cut, turnAtFork: Option.flatMap(Option.fromNullishOr(endings.at(-1)), (event) => event.turn).pipe(Option.getOrElse(() => 0)) }),
      }).pipe(Effect.mapError(storageFailure))
      if (copied.length > 0) yield* compatibilityCommit(log, created.header.id, () => Effect.succeed({ drafts: copied.map((event) => ({ kind: event.kind, turn: Option.none(), data: event.data })), result: undefined })).pipe(
        Effect.onError(() => log.remove(created.header.id).pipe(Effect.ignore)),
      )
      return yield* recordOf(created)
    }).pipe(Effect.uninterruptible),
  })
}))
