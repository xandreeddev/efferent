import { Clock, Effect, Layer, Option, Result, Schema } from "effect"
import { AgentMessage, Checkpoint, ConversationId, ConversationStore, ConversationSummary, HarnessError, RunOutcomeRecord, SessionLog, StoredMessage, StoreError } from "@xandreed/core"
import type { SessionDraft, SessionHead, SessionLogEvent } from "@xandreed/core"
import { compatibilityCommit, compatibilityHistory, compatibilityLast } from "../compatibility.adapter.js"
import { makeSessionLogSqlite, sqliteLogInternals } from "../session-log.adapter.js"
import type { ConversationOverview } from "../session-log.adapter.js"

const MESSAGE = "conversation.message"
const CHECKPOINT = "conversation.checkpoint"
const TITLE = "conversation.title"
const OUTCOME = "conversation.outcome"
const failed = (error: unknown) => new StoreError({ message: error instanceof Error ? error.message : String(error) })
const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(AgentMessage))
// An unknown literal (a future outcome kind) reads as no outcome in the listing.
const decodeListedOutcome = Schema.decodeUnknownResult(Schema.Struct({
  outcome: Schema.Literals(["ok", "partial"]),
  reason: Schema.Literals(["completed", "step-cap", "degenerate-loop"]),
}))
const draft = (kind: string, data: Readonly<Record<string, unknown>>): SessionDraft => ({ kind, data, turn: Option.none() })
const positioned = (events: ReadonlyArray<SessionLogEvent>) => Effect.forEach(events.filter((event) => event.kind === MESSAGE), (event) => {
  const decoded = decodeMessage(typeof event.data.content === "string" ? event.data.content : "")
  return Result.match(decoded, {
    onFailure: (issue) => Effect.logWarning(`conversation ${event.session}: skipping undecodable message at ${event.data.position}: ${String(issue)}`).pipe(Effect.as(Option.none<StoredMessage>())),
    onSuccess: (message) => typeof event.data.position === "number" ? Effect.succeed(Option.some(new StoredMessage({ position: event.data.position, message }))) : Effect.succeed(Option.none<StoredMessage>()),
  })
}).pipe(Effect.map((rows) => rows.flatMap(Option.toArray)))
/** The checkpoint covering the most messages; among equal ones, the newest. */
const latestFold = (events: ReadonlyArray<SessionLogEvent>, upTo = Number.MAX_SAFE_INTEGER) => events
  .filter((event) => event.kind === CHECKPOINT && Number(event.data.messagePosition) <= upTo)
  .reduce((best, event) => Option.match(best, {
    onNone: () => Option.some(event),
    onSome: (current) => Number(event.data.messagePosition) >= Number(current.data.messagePosition) ? Option.some(event) : best,
  }), Option.none<SessionLogEvent>())
const summaryOf = (row: ConversationOverview) => {
  const first = Option.flatMap(row.first, (data) => typeof data.content === "string" ? Result.getSuccess(decodeMessage(data.content)) : Option.none())
  return new ConversationSummary({
    id: row.id, createdAt: row.createdAt,
    title: Option.flatMap(row.title, (data) => typeof data.title === "string" ? Option.some(data.title) : Option.none()),
    firstPrompt: Option.flatMap(first, (message) => message.role === "user" ? Option.some(message.content.slice(0, 120)) : Option.none()),
    lastOutcome: Option.flatMap(row.outcome, (data) => Result.getSuccess(decodeListedOutcome({ outcome: data.outcome, reason: data.reason }))),
  })
}

/**
 * @deprecated Positional conversation API projected over the host's unified SessionLog.
 *
 * Over this package's SQLite log it lists a workspace in one query and prunes
 * in one transaction. Over any other log the listing reads each
 * conversation's first message and latest title and outcome, and pruning
 * needs the host's `prune`.
 */
export const ConversationStoreProjectionLive = (options: {
  readonly prune?: (beforeEpochMs: number) => Effect.Effect<number, StoreError>
} = {}): Layer.Layer<ConversationStore, never, SessionLog> => Layer.effect(ConversationStore, Effect.gen(function* () {
  const log = yield* SessionLog
  const sqlite = sqliteLogInternals(log)
  /** A conversation nobody wrote to yet reads as empty. */
  const orEmpty = <A>(read: Effect.Effect<A, HarnessError>, empty: A): Effect.Effect<A, StoreError> => read.pipe(
    Effect.catchTag("HarnessError", (error) => error.code === "session.missing" ? Effect.succeed(empty) : Effect.fail(error)), Effect.mapError(failed),
  )
  const read = (id: ConversationId) => orEmpty<ReadonlyArray<SessionLogEvent>>(compatibilityHistory(log, id, [MESSAGE, CHECKPOINT, TITLE, OUTCOME]), [])
  const last = (id: ConversationId, kind: string, upTo?: number) => orEmpty(compatibilityLast(log, id, [kind], upTo), Option.none<SessionLogEvent>())
  const checkpointOf = (id: ConversationId, events: ReadonlyArray<SessionLogEvent>) => Option.match(latestFold(events), {
    onNone: () => Effect.succeed(Option.none<Checkpoint>()),
    onSome: (latest) => Schema.decodeUnknownEffect(Checkpoint)({ conversationId: id, ...latest.data }).pipe(Effect.map(Option.some), Effect.mapError(failed)),
  })
  const ensure = (id: ConversationId) => log.head(id).pipe(Effect.catchTag("SessionMissing", () => Clock.currentTimeMillis.pipe(Effect.flatMap((createdAt) => log.create({
    id, owner: "conversation-store", origin: "conversation", createdAt, meta: { projection: "conversation", workspace: "conversation-store" }, parent: Option.none(),
  }).pipe(Effect.catchTag("SessionExists", () => log.head(id)))))), Effect.mapError(failed), Effect.asVoid)
  const commit = <A>(id: ConversationId, plan: (head: SessionHead) => Effect.Effect<{ readonly drafts: ReadonlyArray<SessionDraft>; readonly result: A }, StoreError>) => ensure(id).pipe(
    Effect.andThen(compatibilityCommit(log, id, (head) => plan(head).pipe(Effect.mapError((error) => new HarnessError({ code: "conversation.store", message: error.message }))))), Effect.map((done) => done.result), Effect.mapError(failed),
  )
  /** The latest message position at the planned head (-1 before the first): found by a search, never by reading the history. */
  const lastPosition = (id: ConversationId, head: SessionHead) => last(id, MESSAGE, head.seq).pipe(Effect.map(Option.match({ onNone: () => -1, onSome: (event) => Number(event.data.position) })))
  const appendAll = (id: ConversationId, messages: ReadonlyArray<AgentMessage>): Effect.Effect<ReadonlyArray<number>, StoreError> => messages.length === 0 ? Effect.succeed<ReadonlyArray<number>>([]) : commit(id, (head) => lastPosition(id, head).pipe(Effect.map((previous) => {
    const positions = messages.map((_, index) => previous + index + 1)
    return { drafts: messages.map((message, index) => draft(MESSAGE, { position: positions[index], content: JSON.stringify(message) })), result: positions }
  })))
  const checkpointAt = (id: ConversationId, summary: string, messagePosition: number) => commit(id, () => Clock.currentTimeMillis.pipe(Effect.map((createdAt) => ({
    drafts: [draft(CHECKPOINT, { summary, messagePosition, createdAt })], result: undefined,
  }))))
  const latestOutcome = (id: ConversationId) => last(id, OUTCOME).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.succeed(Option.none<RunOutcomeRecord>()),
    onSome: (latest) => Schema.decodeUnknownEffect(RunOutcomeRecord)({ conversationId: id, ...latest.data }).pipe(Effect.map(Option.some), Effect.mapError(failed)),
  })))
  /** Without the SQLite log: the owner's conversation sessions, each read for its first message and its latest title and outcome. */
  const overviews = (owner: string): Effect.Effect<ReadonlyArray<ConversationOverview>, StoreError> => log.list({ owner, limit: Number.MAX_SAFE_INTEGER, before: Option.none(), parent: Option.none() }).pipe(
    Effect.mapError(failed),
    Effect.map((heads) => heads.filter((head) => head.header.origin === "conversation").sort((a, b) => b.header.createdAt - a.header.createdAt || (a.header.id < b.header.id ? 1 : -1))),
    Effect.flatMap((heads) => Effect.forEach(heads, (head) => Effect.gen(function* () {
      const first = yield* log.read(head.header.id, { after: 0, limit: Option.some(1), kinds: [MESSAGE] }).pipe(Effect.mapError(failed))
      const title = yield* last(head.header.id, TITLE)
      const outcome = yield* last(head.header.id, OUTCOME)
      return { id: head.header.id, createdAt: head.header.createdAt, first: Option.map(Option.fromNullishOr(first[0]), (event) => event.data), title: Option.map(title, (event) => event.data), outcome: Option.map(outcome, (event) => event.data) }
    }))),
  )
  return ConversationStore.of({
    create: (workspace = "conversation-store") => Clock.currentTimeMillis.pipe(Effect.flatMap((createdAt) => log.create({
      id: ConversationId.make(crypto.randomUUID()), owner: workspace, origin: "conversation", createdAt, meta: { workspace, projection: "conversation" }, parent: Option.none(),
    })), Effect.map((head) => head.header.id), Effect.mapError(failed)),
    append: (id, message) => appendAll(id, [message]).pipe(Effect.map((positions) => positions[0] ?? 0)), appendAll,
    list: (id) => read(id).pipe(Effect.flatMap(positioned), Effect.map((rows) => rows.map((row) => row.message))),
    listActive: (id) => read(id).pipe(Effect.flatMap((events) => Effect.all([positioned(events), checkpointOf(id, events)])), Effect.map(([rows, checkpoint]) => rows.filter((row) => row.position > Option.match(checkpoint, { onNone: () => -1, onSome: (fold) => fold.messagePosition })))),
    checkpoint: (id, summary) => commit(id, (head) => Effect.gen(function* () {
      const messagePosition = yield* lastPosition(id, head)
      return { drafts: [draft(CHECKPOINT, { summary, messagePosition, createdAt: yield* Clock.currentTimeMillis })], result: undefined }
    })), checkpointAt,
    latestCheckpoint: (id) => read(id).pipe(Effect.flatMap((events) => checkpointOf(id, events))),
    setTitle: (id, title) => commit(id, () => Effect.succeed({ drafts: [draft(TITLE, { title })], result: undefined })),
    recordOutcome: (id, outcome, reason) => commit(id, () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ drafts: [draft(OUTCOME, { at, outcome, reason })], result: undefined })))), latestOutcome,
    listByWorkspace: (workspace) => Option.match(sqlite, {
      onNone: () => overviews(workspace),
      onSome: (internals) => internals.conversations(workspace).pipe(Effect.mapError(failed)),
    }).pipe(Effect.map((rows) => rows.map(summaryOf))),
    fork: (id, upToPosition = Number.MAX_SAFE_INTEGER) => Effect.gen(function* () {
      const source = yield* log.head(id).pipe(Effect.mapError((error) => new StoreError({ message: `conversation ${id} not found: ${String(error)}` })))
      const records = yield* read(id)
      const messages = records.filter((event) => event.kind === MESSAGE && Number(event.data.position) <= upToPosition)
      const checkpoint = latestFold(records, upToPosition)
      const title = records.filter((event) => event.kind === TITLE).at(-1)?.data.title
      const created = yield* log.create({ id: ConversationId.make(crypto.randomUUID()), owner: source.header.owner, origin: "conversation", createdAt: yield* Clock.currentTimeMillis,
        meta: { ...source.header.meta, forkedFrom: id, projection: "conversation" }, parent: Option.none() }).pipe(Effect.mapError(failed))
      yield* commit(created.header.id, () => Effect.succeed({ drafts: [...messages.map((event) => draft(event.kind, event.data)), ...Option.toArray(Option.map(checkpoint, (fold) => draft(fold.kind, fold.data))), ...(typeof title === "string" ? [draft(TITLE, { title: `fork: ${title}` })] : [])], result: undefined })).pipe(
        Effect.onError(() => log.remove(created.header.id).pipe(Effect.ignore)),
      )
      return created.header.id
    }).pipe(Effect.uninterruptible),
    prune: options.prune ?? ((before) => Option.match(sqlite, {
      onNone: () => Effect.fail(new StoreError({ message: "pruning requires the storage host's explicit retention adapter" })),
      onSome: (internals) => internals.prune(before).pipe(Effect.mapError(failed)),
    })),
  })
}))

/** @deprecated Convenience host composition: the projection over one SQLite session log, opened once. */
export const SqliteConversationStoreLive = (dbPath: string): Layer.Layer<ConversationStore, StoreError> => Layer.unwrap(
  makeSessionLogSqlite(dbPath).pipe(Effect.mapError(failed), Effect.map((log) => ConversationStoreProjectionLive().pipe(Layer.provide(Layer.succeed(SessionLog, log))))),
)
