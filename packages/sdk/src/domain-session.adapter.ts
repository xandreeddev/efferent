import { Effect, Fiber, Filter, Option, Ref, Stream } from "effect"
import { AgentLoop, ConversationStore, HarnessError, SessionEnvironment, SessionStore, StoreError } from "@xandreed/core"
import type { ConversationId, EventBody, Session, SessionHandle } from "@xandreed/core"

/**
 * The conversation store a domain session gets: its writes to its own
 * conversation are accepted while a harness run is active on it, and refused
 * once the run is over (ended, interrupted, or its turn closed elsewhere and
 * noticed), so a late write fails loudly instead of being recorded after it.
 */
const turnBound = (store: ConversationStore["Service"], id: ConversationId, active: Ref.Ref<boolean>): ConversationStore["Service"] => {
  const guard = <A>(target: ConversationId, write: Effect.Effect<A, StoreError>): Effect.Effect<A, StoreError> => target !== id ? write : Ref.get(active).pipe(
    Effect.flatMap((open) => open ? write : Effect.fail(new StoreError({ message: `conversation ${id}: its turn is over, so the write is refused` }))))
  return ConversationStore.of({
    ...store,
    append: (target, message) => guard(target, store.append(target, message)),
    appendAll: (target, messages) => guard(target, store.appendAll(target, messages)),
    checkpoint: (target, summary) => guard(target, store.checkpoint(target, summary)),
    checkpointAt: (target, summary, position) => guard(target, store.checkpointAt(target, summary, position)),
    setTitle: (target, title) => guard(target, store.setTitle(target, title)),
    recordOutcome: (target, outcome, reason) => guard(target, store.recordOutcome(target, outcome, reason)),
  })
}

/**
 * Adapt a domain session's event protocol to the durable harness lifecycle.
 * When the host provides a ConversationStore, the domain session's writes to
 * its conversation are bound to the harness run (see `turnBound`). They are
 * recorded beside the turn, not through its writer.
 */
export const domainLoop = <E extends { readonly type: string }, R>(options: {
  readonly create: (id: ConversationId) => Effect.Effect<Session<E>, never, R>
  readonly snapshot?: (id: ConversationId) => Effect.Effect<Readonly<Record<string, unknown>>, HarnessError, R>
  readonly restore?: (id: ConversationId, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, HarnessError, R>
  readonly result: (event: E) => Option.Option<{ readonly text: string; readonly outcome: "completed" | "partial" }>
}) => Effect.gen(function* () {
  const context = yield* Effect.context<R>()
  const store = yield* SessionStore
  const environment = yield* Effect.serviceOption(SessionEnvironment)
  const conversations = yield* Effect.serviceOption(ConversationStore)
  const running = yield* Ref.make(false)
  const acquire = (id: ConversationId) => Effect.gen(function* () {
    if (options.restore !== undefined) {
      const snapshot = (yield* store.read(id, -1)).filter((event) => event.name === "domain.snapshot").at(-1)
      if (snapshot !== undefined) yield* options.restore(id, snapshot.data).pipe(Effect.provide(context))
    }
    const created = options.create(id)
    return yield* Option.match(conversations, {
      onNone: () => created,
      onSome: (conversation) => created.pipe(Effect.provideService(ConversationStore, turnBound(conversation, id, running))),
    }).pipe(Effect.provide(context))
  })
  const record = Option.isSome(environment) ? environment.value.session : undefined
  const active = yield* Ref.make(record === undefined ? Option.none<Session<E>>() : Option.some(yield* acquire(record.id)))
  yield* Effect.addFinalizer(() => Ref.get(active).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (session) => session.shutdown }))))
  return AgentLoop.of({ run: (input) => Effect.scoped(Effect.gen(function* () {
    yield* Ref.set(running, true)
    const found = yield* Ref.get(active)
    const session = Option.isSome(found) ? found.value : yield* acquire(input.session.id).pipe(Effect.tap((value) => Ref.set(active, Option.some(value))))
    const cursor = (yield* session.state).cursor
    const result = yield* Ref.make(Option.none<{ readonly text: string; readonly outcome: "completed" | "partial" }>())
    const collector = yield* Effect.forkScoped(session.subscribe(cursor).pipe(
      Stream.tap(({ event }) => input.publish({ name: "domain.event", runId: input.runId, data: { event } })),
      Stream.tap(({ event }) => Ref.update(result, (current) => Option.orElse(options.result(event), () => current))),
      Stream.takeUntil(({ event }) => Option.isSome(options.result(event))), Stream.runDrain,
    ))
    yield* Effect.forkScoped(session.transient.pipe(Stream.runForEach((event) => input.transient({ name: "domain.delta", runId: input.runId, data: { event } }))))
    yield* session.send(input.userMessage.text)
    const settled = (yield* session.state).log.filter((entry) => entry.seq >= cursor).some(({ event }) => Option.isSome(options.result(event)))
    if (!settled) return yield* Effect.fail(new HarnessError({ code: "domain.unsettled", message: "The domain turn ended without a terminal event" }))
    yield* Fiber.join(collector)
    if (options.snapshot !== undefined) yield* options.snapshot(input.session.id).pipe(Effect.provide(context), Effect.flatMap((data) => input.publish({ name: "domain.snapshot", runId: input.runId, data })))
    return yield* Ref.get(result).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(new HarnessError({ code: "domain.result", message: "The domain session ended without a result" })), onSome: Effect.succeed })))
  })).pipe(Effect.ensuring(Ref.set(running, false)), Effect.onInterrupt(() => Ref.get(active).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (session) => session.interrupt }))))) })
})

/** Preserve a domain host's public stream vocabulary while the SDK owns lifecycle. */
export const domainSession = <E>(handle: SessionHandle, decode: (value: unknown) => Option.Option<E>, onError: (message: string) => E): Session<E> => {
  const event = (name: string, data: Readonly<Record<string, unknown>>) => name === "domain.event" ? decode(data.event)
    : ["run.failed", "run.cancelled"].includes(name) ? Option.some(onError(String(data.message))) : Option.none<E>()
  return {
    conversationId: handle.record.id,
    send: (text) => handle.send(text).pipe(Effect.ignore), interrupt: handle.interrupt, shutdown: handle.close,
    state: handle.history.pipe(Effect.map((events) => ({ cursor: (events.at(-1)?.seq ?? -1) + 1, log: events.flatMap((entry) => Option.toArray(Option.map(event(entry.name, entry.data), (value) => ({ seq: entry.seq, event: value })))) })), Effect.orDie),
    subscribe: (since) => handle.events(since - 1).pipe(Stream.map((entry) => Option.map(event(entry.name, entry.data), (value) => ({ seq: entry.seq, event: value }))), Stream.filterMap(Filter.fromPredicateOption((value) => value)), Stream.orDie),
    transient: handle.transient.pipe(Stream.filterMap(Filter.fromPredicateOption((entry: EventBody) => entry.name === "domain.delta" ? decode(entry.data.event) : Option.none()))),
  }
}
