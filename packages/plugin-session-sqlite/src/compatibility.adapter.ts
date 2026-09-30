import { Clock, Effect, Layer, Option, Schema } from "effect"
import { ConversationId, HarnessError, SessionEvent, SessionLog, SessionRecord, SessionStore } from "@xandreed/core"
import type { EventBody, SessionCommitted, SessionDraft, SessionHead, SessionLogEvent } from "@xandreed/core"

const storageFailure = (error: { readonly _tag: string; readonly message?: string }) => new HarnessError({ code: error._tag === "SessionMissing" ? "session.missing" : "session.log", message: error.message ?? error._tag })
const eventOf = Schema.decodeUnknownEffect(SessionEvent)

/** Read inherited records at their immutable fork boundary, then the child's own records. */
export const compatibilityHistory = (log: SessionLog["Service"], id: ConversationId, kinds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => Effect.gen(function* () {
  const head = yield* log.head(id).pipe(Effect.mapError(storageFailure))
  const inherited = yield* Option.match(head.header.parent, {
    onNone: () => Effect.succeed<ReadonlyArray<SessionLogEvent>>([]),
    onSome: (parent) => compatibilityHistory(log, parent.id, kinds).pipe(Effect.map((events) => events.filter((event) => event.session !== parent.id || event.seq <= parent.through))),
  })
  const own = yield* log.read(id, { after: 0, limit: Option.none(), kinds }).pipe(Effect.mapError(storageFailure))
  return [...inherited, ...own]
})

/** Plan against the head's revision; a conflict re-reads and re-plans. */
export const compatibilityCommit = <A>(log: SessionLog["Service"], id: ConversationId, plan: (head: SessionHead) => Effect.Effect<{ readonly drafts: ReadonlyArray<SessionDraft>; readonly result: A }, HarnessError>): Effect.Effect<{ readonly committed: SessionCommitted; readonly result: A }, HarnessError> => {
  const attempt = (tries: number): Effect.Effect<{ readonly committed: SessionCommitted; readonly result: A }, HarnessError> => Effect.gen(function* () {
    const head = yield* log.head(id).pipe(Effect.mapError(storageFailure))
    const planned = yield* plan(head)
    return yield* log.commit(id, { expect: head.revision, notAfter: Option.none(), state: Option.none(), events: planned.drafts }).pipe(
      Effect.map((committed) => ({ committed, result: planned.result })),
      Effect.catchTag("RevisionConflict", (conflict) => tries < 8 ? attempt(tries + 1) : Effect.fail(storageFailure(conflict))),
      Effect.mapError((error) => error instanceof HarnessError ? error : storageFailure(error)),
    )
  })
  return attempt(0)
}

/** Includes branches, preserving the historical list contract. */
export const compatibilityListing = (log: SessionLog["Service"], owner: string, parent = Option.none<ConversationId>()): Effect.Effect<ReadonlyArray<SessionHead>, HarnessError> => Effect.gen(function* () {
  const heads = yield* log.list({ owner, limit: Number.MAX_SAFE_INTEGER, before: Option.none(), parent }).pipe(Effect.mapError(storageFailure))
  const children = yield* Effect.forEach(heads, (head) => compatibilityListing(log, owner, Option.some(head.header.id)))
  return [...heads, ...children.flat()].sort((a, b) => b.header.createdAt - a.header.createdAt)
})

const recordOf = (head: SessionHead) => Schema.decodeUnknownEffect(SessionRecord)({
  id: head.header.id, workspace: head.header.owner, profile: head.header.meta.profile ?? "smith", createdAt: head.header.createdAt,
  ...Option.match(head.header.parent, { onNone: () => typeof head.header.meta.legacyParent === "string" ? { parent: head.header.meta.legacyParent } : {}, onSome: (parent) => ({ parent: parent.id }) }),
}).pipe(Effect.mapError((error) => new HarnessError({ code: "session.decode", message: String(error) })))

export const harnessHistory = (log: SessionLog["Service"], id: ConversationId, after = -1): Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError> => compatibilityHistory(log, id, ["harness.event"]).pipe(
  Effect.flatMap((events) => Effect.forEach(events.filter((event) => typeof event.data.event !== "object" || event.data.event === null || !("seq" in event.data.event) || typeof event.data.event.seq !== "number" || event.data.event.seq > after), (event) => eventOf(event.data.event).pipe(Effect.map((decoded) => ({ ...decoded, sessionId: id })), Effect.mapError((error) => new HarnessError({ code: "session.decode", message: String(error) }))))),
)

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
    append: (id, body) => compatibilityCommit(log, id, () => Effect.gen(function* () {
      const events = yield* harnessHistory(log, id)
      const event = harnessEvent(id, body, (events.at(-1)?.seq ?? -1) + 1, yield* Clock.currentTimeMillis)
      return { drafts: [{ kind: "harness.event", turn: Option.none(), data: { event } }], result: event }
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
