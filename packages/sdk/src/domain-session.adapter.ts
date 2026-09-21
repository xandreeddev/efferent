import { Effect, Fiber, Option, Ref, Stream } from "effect"
import { AgentLoop, HarnessError, SessionEnvironment, SessionStore } from "@xandreed/core"
import type { ConversationId, Session, SessionHandle } from "@xandreed/core"

/** Adapt a domain session's event protocol to the durable harness lifecycle. */
export const domainLoop = <E extends { readonly type: string }, R>(options: {
  readonly create: (id: ConversationId) => Effect.Effect<Session<E>, never, R>
  readonly snapshot?: (id: ConversationId) => Effect.Effect<Readonly<Record<string, unknown>>, HarnessError, R>
  readonly restore?: (id: ConversationId, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, HarnessError, R>
  readonly result: (event: E) => Option.Option<{ readonly text: string; readonly outcome: "completed" | "partial" }>
}) => Effect.gen(function* () {
  const context = yield* Effect.context<R>()
  const store = yield* SessionStore
  const environment = yield* Effect.serviceOption(SessionEnvironment)
  const acquire = (id: ConversationId) => Effect.gen(function* () {
    if (options.restore !== undefined) {
      const snapshot = (yield* store.read(id, -1)).filter((event) => event.name === "domain.snapshot").at(-1)
      if (snapshot !== undefined) yield* options.restore(id, snapshot.data).pipe(Effect.provide(context))
    }
    return yield* options.create(id).pipe(Effect.provide(context))
  })
  const record = Option.isSome(environment) ? environment.value.session : undefined
  const active = yield* Ref.make(record === undefined ? Option.none<Session<E>>() : Option.some(yield* acquire(record.id)))
  yield* Effect.addFinalizer(() => Ref.get(active).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (session) => session.shutdown }))))
  return AgentLoop.of({ run: (input) => Effect.scoped(Effect.gen(function* () {
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
    yield* session.send(input.prompt)
    const settled = (yield* session.state).log.filter((entry) => entry.seq >= cursor).some(({ event }) => Option.isSome(options.result(event)))
    if (!settled) return yield* Effect.fail(new HarnessError({ code: "domain.unsettled", message: "The domain turn ended without a terminal event" }))
    yield* Fiber.join(collector)
    if (options.snapshot !== undefined) yield* options.snapshot(input.session.id).pipe(Effect.provide(context), Effect.flatMap((data) => input.publish({ name: "domain.snapshot", runId: input.runId, data })))
    return yield* Ref.get(result).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(new HarnessError({ code: "domain.result", message: "The domain session ended without a result" })), onSome: Effect.succeed })))
  })).pipe(Effect.onInterrupt(() => Ref.get(active).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (session) => session.interrupt }))))) })
})

/** Preserve a domain host's public stream vocabulary while the SDK owns lifecycle. */
export const domainSession = <E>(handle: SessionHandle, decode: (value: unknown) => Option.Option<E>, onError: (message: string) => E): Session<E> => {
  const event = (name: string, data: Readonly<Record<string, unknown>>) => name === "domain.event" ? decode(data.event)
    : ["run.failed", "run.cancelled"].includes(name) ? Option.some(onError(String(data.message))) : Option.none<E>()
  return {
    conversationId: handle.record.id,
    send: (text) => handle.send(text).pipe(Effect.ignore), interrupt: handle.interrupt, shutdown: handle.close,
    state: handle.history.pipe(Effect.map((events) => ({ cursor: (events.at(-1)?.seq ?? -1) + 1, log: events.flatMap((entry) => Option.toArray(Option.map(event(entry.name, entry.data), (value) => ({ seq: entry.seq, event: value })))) })), Effect.orDie),
    subscribe: (since) => handle.events(since - 1).pipe(Stream.map((entry) => Option.map(event(entry.name, entry.data), (value) => ({ seq: entry.seq, event: value }))), Stream.filterMap((value) => value), Stream.orDie),
    transient: handle.transient.pipe(Stream.filterMap((entry) => entry.name === "domain.delta" ? decode(entry.data.event) : Option.none())),
  }
}
