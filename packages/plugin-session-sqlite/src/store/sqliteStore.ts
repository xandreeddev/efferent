import { Database } from "bun:sqlite"
import { Clock, Effect, Layer, Option, Result, Schema } from "effect"
import { AgentMessage, Checkpoint, ConversationId, ConversationStore, ConversationSummary, HarnessError, RunOutcomeRecord, SessionLog, StoredMessage, StoreError } from "@xandreed/core"
import type { SessionDraft, SessionLogEvent } from "@xandreed/core"
import { compatibilityCommit, compatibilityHistory, compatibilityListing } from "../compatibility.adapter.js"
import { SessionLogSqliteLive } from "../session-log.adapter.js"

const MESSAGE = "conversation.message"
const CHECKPOINT = "conversation.checkpoint"
const TITLE = "conversation.title"
const OUTCOME = "conversation.outcome"
const failed = (error: unknown) => new StoreError({ message: error instanceof Error ? error.message : String(error) })
const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(AgentMessage))
const draft = (kind: string, data: Readonly<Record<string, unknown>>): SessionDraft => ({ kind, data, turn: Option.none() })
const positioned = (events: ReadonlyArray<SessionLogEvent>) => Effect.forEach(events.filter((event) => event.kind === MESSAGE), (event) => {
  const decoded = decodeMessage(typeof event.data.content === "string" ? event.data.content : "")
  return Result.match(decoded, {
    onFailure: (issue) => Effect.logWarning(`conversation ${event.session}: skipping undecodable message at ${event.data.position}: ${String(issue)}`).pipe(Effect.as(Option.none<StoredMessage>())),
    onSuccess: (message) => typeof event.data.position === "number" ? Effect.succeed(Option.some(new StoredMessage({ position: event.data.position, message }))) : Effect.succeed(Option.none<StoredMessage>()),
  })
}).pipe(Effect.map((rows) => rows.flatMap(Option.toArray)))

/** @deprecated Positional conversation API projected over the host's unified SessionLog. */
export const ConversationStoreProjectionLive = (options: {
  readonly prune?: (beforeEpochMs: number) => Effect.Effect<number, StoreError>
} = {}): Layer.Layer<ConversationStore, never, SessionLog> => Layer.effect(ConversationStore, Effect.gen(function* () {
  const log = yield* SessionLog
  const read = (id: ConversationId) => compatibilityHistory(log, id, [MESSAGE, CHECKPOINT, TITLE, OUTCOME]).pipe(
    Effect.catchTag("HarnessError", (error) => error.code === "session.missing" ? Effect.succeed<ReadonlyArray<SessionLogEvent>>([]) : Effect.fail(error)), Effect.mapError(failed),
  )
  const checkpointOf = (id: ConversationId, events: ReadonlyArray<SessionLogEvent>) => {
    const latest = events.filter((event) => event.kind === CHECKPOINT).sort((a, b) => Number(b.data.messagePosition) - Number(a.data.messagePosition))[0]
    return latest === undefined ? Effect.succeed(Option.none<Checkpoint>()) : Schema.decodeUnknownEffect(Checkpoint)({ conversationId: id, ...latest.data }).pipe(Effect.map(Option.some), Effect.mapError(failed))
  }
  const ensure = (id: ConversationId) => log.head(id).pipe(Effect.catchTag("SessionMissing", () => Clock.currentTimeMillis.pipe(Effect.flatMap((createdAt) => log.create({
    id, owner: "conversation-store", origin: "conversation", createdAt, meta: { projection: "conversation", workspace: "conversation-store" }, parent: Option.none(),
  }).pipe(Effect.catchTag("SessionExists", () => log.head(id)))))), Effect.mapError(failed), Effect.asVoid)
  const commit = <A>(id: ConversationId, plan: () => Effect.Effect<{ readonly drafts: ReadonlyArray<SessionDraft>; readonly result: A }, StoreError>) => ensure(id).pipe(
    Effect.andThen(compatibilityCommit(log, id, () => plan().pipe(Effect.mapError((error) => new HarnessError({ code: "conversation.store", message: error.message }))))), Effect.map((done) => done.result), Effect.mapError(failed),
  )
  const appendAll = (id: ConversationId, messages: ReadonlyArray<AgentMessage>): Effect.Effect<ReadonlyArray<number>, StoreError> => messages.length === 0 ? Effect.succeed<ReadonlyArray<number>>([]) : commit(id, () => read(id).pipe(Effect.map((events) => {
    const previous = events.filter((event) => event.kind === MESSAGE).reduce((max, event) => Math.max(max, Number(event.data.position)), -1)
    const positions = messages.map((_, index) => previous + index + 1)
    return { drafts: messages.map((message, index) => draft(MESSAGE, { position: positions[index], content: JSON.stringify(message) })), result: positions }
  })))
  const checkpointAt = (id: ConversationId, summary: string, messagePosition: number) => commit(id, () => Clock.currentTimeMillis.pipe(Effect.map((createdAt) => ({
    drafts: [draft(CHECKPOINT, { summary, messagePosition, createdAt })], result: undefined,
  }))))
  const latestOutcome = (id: ConversationId) => read(id).pipe(Effect.flatMap((events) => {
    const latest = events.filter((event) => event.kind === OUTCOME).at(-1)
    return latest === undefined ? Effect.succeed(Option.none<RunOutcomeRecord>()) : Schema.decodeUnknownEffect(RunOutcomeRecord)({ conversationId: id, ...latest.data }).pipe(Effect.map(Option.some), Effect.mapError(failed))
  }))
  return ConversationStore.of({
    create: (workspace = "conversation-store") => Clock.currentTimeMillis.pipe(Effect.flatMap((createdAt) => log.create({
      id: ConversationId.make(crypto.randomUUID()), owner: workspace, origin: "conversation", createdAt, meta: { workspace, projection: "conversation" }, parent: Option.none(),
    })), Effect.map((head) => head.header.id), Effect.mapError(failed)),
    append: (id, message) => appendAll(id, [message]).pipe(Effect.map((positions) => positions[0] ?? 0)), appendAll,
    list: (id) => read(id).pipe(Effect.flatMap(positioned), Effect.map((rows) => rows.map((row) => row.message))),
    listActive: (id) => read(id).pipe(Effect.flatMap((events) => Effect.all([positioned(events), checkpointOf(id, events)])), Effect.map(([rows, checkpoint]) => rows.filter((row) => row.position > Option.match(checkpoint, { onNone: () => -1, onSome: (fold) => fold.messagePosition })))),
    checkpoint: (id, summary) => commit(id, () => Effect.gen(function* () {
      const events = yield* read(id)
      const messagePosition = events.filter((event) => event.kind === MESSAGE).reduce((max, event) => Math.max(max, Number(event.data.position)), -1)
      return { drafts: [draft(CHECKPOINT, { summary, messagePosition, createdAt: yield* Clock.currentTimeMillis })], result: undefined }
    })), checkpointAt,
    latestCheckpoint: (id) => read(id).pipe(Effect.flatMap((events) => checkpointOf(id, events))),
    setTitle: (id, title) => commit(id, () => Effect.succeed({ drafts: [draft(TITLE, { title })], result: undefined })),
    recordOutcome: (id, outcome, reason) => commit(id, () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ drafts: [draft(OUTCOME, { at, outcome, reason })], result: undefined })))), latestOutcome,
    listByWorkspace: (workspace) => compatibilityListing(log, workspace).pipe(Effect.mapError(failed), Effect.flatMap((heads) => Effect.forEach(heads, (head) => Effect.gen(function* () {
      const events = yield* read(head.header.id)
      const messages = yield* positioned(events)
      const first = messages[0]?.message
      const title = events.filter((event) => event.kind === TITLE).at(-1)?.data.title
      const outcome = yield* latestOutcome(head.header.id)
      return new ConversationSummary({ id: head.header.id, createdAt: head.header.createdAt, title: typeof title === "string" ? Option.some(title) : Option.none(),
        firstPrompt: first?.role === "user" ? Option.some(first.content.slice(0, 120)) : Option.none(), lastOutcome: Option.map(outcome, (value) => ({ outcome: value.outcome, reason: value.reason })) })
    })))),
    fork: (id, upToPosition = Number.MAX_SAFE_INTEGER) => Effect.gen(function* () {
      const source = yield* log.head(id).pipe(Effect.mapError((error) => new StoreError({ message: `conversation ${id} not found: ${String(error)}` })))
      const records = yield* read(id)
      const messages = records.filter((event) => event.kind === MESSAGE && Number(event.data.position) <= upToPosition)
      const checkpoint = records.filter((event) => event.kind === CHECKPOINT && Number(event.data.messagePosition) <= upToPosition).sort((a, b) => Number(b.data.messagePosition) - Number(a.data.messagePosition))[0]
      const title = records.filter((event) => event.kind === TITLE).at(-1)?.data.title
      const created = yield* log.create({ id: ConversationId.make(crypto.randomUUID()), owner: source.header.owner, origin: "conversation", createdAt: yield* Clock.currentTimeMillis,
        meta: { ...source.header.meta, forkedFrom: id, projection: "conversation" }, parent: Option.none() }).pipe(Effect.mapError(failed))
      yield* commit(created.header.id, () => Effect.succeed({ drafts: [...messages.map((event) => draft(event.kind, event.data)), ...(checkpoint === undefined ? [] : [draft(checkpoint.kind, checkpoint.data)]), ...(typeof title === "string" ? [draft(TITLE, { title: `fork: ${title}` })] : [])], result: undefined })).pipe(
        Effect.onError(() => log.remove(created.header.id).pipe(Effect.ignore)),
      )
      return created.header.id
    }).pipe(Effect.uninterruptible),
    prune: options.prune ?? (() => Effect.fail(new StoreError({ message: "pruning requires the storage host's explicit retention adapter" }))),
  })
}))

/** @deprecated Convenience host composition; storage is exclusively SessionLogSqliteLive. */
export const SqliteConversationStoreLive = (dbPath: string) => Layer.unwrap(Effect.gen(function* () {
  const logLayer = SessionLogSqliteLive(dbPath)
  const prune = (before: number) => Effect.gen(function* () {
    const log = yield* SessionLog
    const ids = yield* Effect.acquireUseRelease(
      Effect.try({ try: () => new Database(dbPath, { readonly: true }), catch: failed }),
      (database) => Effect.try({ try: () => database.query<{ id: string }, [number]>("SELECT id FROM session_heads WHERE created_at < ? AND origin = 'conversation'").all(before).map((row) => ConversationId.make(row.id)), catch: failed }),
      (database) => Effect.sync(() => database.close()),
    )
    yield* Effect.forEach(ids, (id) => log.remove(id).pipe(Effect.mapError(failed)), { discard: true })
    return ids.length
  }).pipe(Effect.provide(logLayer), Effect.mapError(failed))
  return ConversationStoreProjectionLive({ prune }).pipe(Layer.provide(logLayer))
}))
