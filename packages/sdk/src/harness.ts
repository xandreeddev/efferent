import { Cause, Context, Effect, Exit, Fiber, Option, PubSub, Ref, Scope, Stream } from "effect"
import { AgentLoop, HarnessError, SessionEnvironment, SessionStore, TurnHooks } from "@xandreed/core"
import type { ConversationId, EventBody, HarnessConfig, Plugin, SessionHandle, SessionRecord } from "@xandreed/core"
import { activateGraph, graphFingerprint, resolveGraph } from "@xandreed/runtime"
import type { PluginGraph } from "@xandreed/runtime"

interface PendingInput { readonly id: string; readonly text: string; readonly kind: "turn" | "steer" }
interface TurnResult { readonly text: string; readonly outcome: "completed" | "partial" }
const failure = (code: string, message: string) => new HarnessError({ code, message })
const service = <I, A>(context: Context.Context<never>, tag: Context.Tag<I, A>): Effect.Effect<A, HarnessError> => Option.match(Context.getOption(context, tag), {
  onNone: () => Effect.fail(failure("service.missing", `The profile does not provide ${tag.key}`)),
  onSome: Effect.succeed,
})

export const makeHarness = (options: {
  readonly config: HarnessConfig
  readonly plugins: ReadonlyArray<Plugin>
  readonly workspace: string
}) => Effect.gen(function* () {
  const parent = yield* Effect.scope
  const initial = yield* resolveGraph(options.config, options.plugins, [SessionEnvironment.key])
  const graphRef = yield* Ref.make(initial)
  const registryRef = yield* Ref.make(options.plugins)
  const seed = Context.make(SessionEnvironment, { workspace: options.workspace })
  const runtime = yield* activateGraph(initial, "runtime", Context.unsafeMake(seed.unsafeMap), parent)
  const store = yield* service(runtime, SessionStore)
  const handles = yield* Ref.make<ReadonlyMap<ConversationId, SessionHandle>>(new Map())

  const open = (record: SessionRecord): Effect.Effect<SessionHandle, HarnessError> => Effect.gen(function* () {
    const existing = (yield* Ref.get(handles)).get(record.id)
    if (existing !== undefined) return existing
    const journal = yield* store.read(record.id, -1)
    const abandoned = journal.reduce((runs, event) => {
      if (event.runId === undefined) return runs
      return event.name === "run.started" ? [...runs, event.runId]
        : ["run.completed", "run.cancelled", "run.failed"].includes(event.name) ? runs.filter((id) => id !== event.runId) : runs
    }, [] as ReadonlyArray<string>)
    yield* Effect.forEach(abandoned, (runId) => store.append(record.id, { name: "run.cancelled", runId, data: { reason: "process interrupted before settlement; tool effects may be incomplete" } }))
    const pending = yield* Ref.make(journal.reduce((queue, event) => {
      if (event.name === "input.queued" && typeof event.data.id === "string" && typeof event.data.text === "string") {
        return [...queue, { id: event.data.id, text: event.data.text, kind: event.data.kind === "steer" ? "steer" as const : "turn" as const }]
      }
      return event.name === "input.claimed" ? queue.filter((input) => input.id !== event.data.id) : queue
    }, [] as ReadonlyArray<PendingInput>))
    const notifications = yield* PubSub.sliding<void>(1)
    const transientHub = yield* PubSub.sliding<EventBody>(128)
    const running = yield* Ref.make(Option.none<Fiber.RuntimeFiber<TurnResult, HarnessError>>())
    const busy = yield* Ref.make(false)
    const closed = yield* Ref.make(false)
    const gate = yield* Effect.makeSemaphore(1)
    const acquire = (graph: PluginGraph) => Effect.gen(function* () {
      const scope = yield* Scope.make()
      const sessionSeed = Context.add(runtime, SessionEnvironment, { workspace: options.workspace, session: record })
      const context = yield* activateGraph(graph, "session", Context.unsafeMake<never>(sessionSeed.unsafeMap), scope).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      )
      yield* service(context, AgentLoop).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
      return { context, scope, graph, fingerprint: graphFingerprint(graph) }
    })
    const mounted = yield* Ref.make(yield* acquire(yield* Ref.get(graphRef)))
    const publish = (body: EventBody) => store.append(record.id, body).pipe(Effect.tap(() => PubSub.publish(notifications, undefined)))
    const assertOpen = Ref.get(closed).pipe(Effect.flatMap((value) => value ? Effect.fail(failure("session.closed", "Session is closed")) : Effect.void))
    const refresh = Effect.gen(function* () {
      if (yield* Ref.get(busy)) return
      const graph = yield* Ref.get(graphRef)
      const previous = yield* Ref.get(mounted)
      if (graphFingerprint(graph) === previous.fingerprint) return
      const next = yield* acquire(graph)
      yield* Ref.set(mounted, next)
      yield* Scope.close(previous.scope, Exit.void)
      yield* publish({ name: "config.applied", data: { fingerprint: next.fingerprint } })
    })
    const claim = (input: PendingInput) => publish({ name: "input.claimed", data: { id: input.id } }).pipe(
      Effect.zipRight(Ref.update(pending, (queue) => queue.filter((item) => item.id !== input.id))),
    )
    const steering = Effect.gen(function* () {
      const inputs = (yield* Ref.get(pending)).filter((input) => input.kind === "steer")
      yield* Effect.forEach(inputs, claim)
      return inputs.length === 0 ? Option.none<string>() : Option.some(inputs.map((input) => input.text).join("\n\n"))
    })
    const run = (input: PendingInput) => Effect.gen(function* () {
      yield* refresh
      const current = yield* Ref.get(mounted)
      const loop = yield* service(current.context, AgentLoop)
      const hooks = Context.getOption(current.context, TurnHooks)
      const runId = crypto.randomUUID()
      yield* claim(input)
      yield* publish({ name: "run.started", runId, data: { config: current.fingerprint } })
      const args = { session: record, runId, prompt: input.text, system: current.graph.config.system ?? "You are a helpful agent.", publish,
        transient: (event: EventBody) => PubSub.publish(transientHub, event).pipe(Effect.asVoid), steering }
      const task = Effect.gen(function* () {
        const prepared = Option.isSome(hooks) ? yield* hooks.value.before(args) : args
        const result = yield* loop.run(prepared)
        if (Option.isSome(hooks)) yield* hooks.value.after(prepared)
        return result
      }).pipe(Effect.interruptible)
      yield* Ref.set(busy, true)
      const fiber = yield* Effect.forkIn(task, parent)
      yield* Ref.set(running, Option.some(fiber))
      const exit = yield* Fiber.await(fiber)
      yield* Ref.set(running, Option.none())
      yield* Ref.set(busy, false)
      yield* Exit.isSuccess(exit)
        ? publish({ name: "run.completed", runId, data: { ...exit.value } })
        : publish({ name: Cause.isInterruptedOnly(exit.cause) ? "run.cancelled" : "run.failed", runId,
          data: { message: Cause.isInterruptedOnly(exit.cause) ? "Cancelled; unfinished tool effects are not replayed" : Cause.pretty(exit.cause) } })
      yield* Ref.set(running, Option.none())
      yield* Ref.set(busy, false)
      if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) return yield* Effect.fail(failure("run.failed", Cause.pretty(exit.cause)))
      return Exit.isSuccess(exit)
    }).pipe(Effect.uninterruptible)
    const drain = gate.withPermits(1)(Effect.gen(function* () {
      yield* assertOpen
      yield* Effect.iterate(true, { while: (more) => more, body: () => Effect.gen(function* () {
        if (yield* Ref.get(closed)) return false
        const next = (yield* Ref.get(pending))[0]
        return next === undefined ? false : yield* run(next)
      }) })
    }))
    const enqueue = (text: string, kind: "turn" | "steer") => Effect.gen(function* () {
      yield* assertOpen
      if (text.trim().length === 0) return yield* Effect.fail(failure("input.empty", "Enter a message"))
      const input = { id: crypto.randomUUID(), text, kind }
      yield* publish({ name: "input.queued", data: input })
      yield* Ref.update(pending, (queue) => [...queue, input])
    })
    const interrupt = Ref.get(running).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid) })))
    const close = Ref.getAndSet(closed, true).pipe(Effect.flatMap((already) => already ? Effect.void : Effect.gen(function* () {
      yield* interrupt
      yield* gate.withPermits(1)(Ref.get(mounted).pipe(Effect.flatMap((current) => Scope.close(current.scope, Exit.void))))
      yield* PubSub.shutdown(notifications)
      yield* PubSub.shutdown(transientHub)
      yield* Ref.update(handles, (all) => new Map([...all].filter(([id]) => id !== record.id)))
    })))
    const handle: SessionHandle = {
      record, use: (tag, run) => gate.withPermits(1)(assertOpen.pipe(Effect.zipRight(Ref.get(mounted)), Effect.flatMap((current) => service(current.context, tag)), Effect.flatMap(run))), send: (text) => enqueue(text, "turn").pipe(Effect.zipRight(drain)),
      steer: (text) => enqueue(text, "steer"), continue: drain, interrupt, close,
      busy: Ref.get(busy), pending: Ref.get(pending), refresh: gate.withPermits(1)(refresh),
      history: store.read(record.id, -1), transient: Stream.fromPubSub(transientHub),
      events: (after = -1) => Stream.unwrapScoped(Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(notifications)
        const cursor = yield* Ref.make(after)
        return Stream.concat(Stream.make(undefined), Stream.fromQueue(subscription)).pipe(
          Stream.mapEffect(() => Ref.get(cursor).pipe(Effect.flatMap((position) => store.read(record.id, position)),
            Effect.tap((events) => events.length === 0 ? Effect.void : Ref.set(cursor, events[events.length - 1]!.seq)))),
          Stream.flatMap(Stream.fromIterable),
        )
      })),
    }
    yield* Scope.addFinalizer(parent, close)
    yield* Ref.update(handles, (all) => new Map([...all, [record.id, handle]]))
    return handle
  })
  const opening = yield* Effect.makeSemaphore(1)
  const ownRecord = (id: ConversationId) => store.get(id).pipe(Effect.flatMap((record) => record.workspace !== options.workspace
    ? Effect.fail(failure("session.workspace", "This session belongs to a different workspace")) : Effect.succeed(record)))
  return {
    create: () => Ref.get(graphRef).pipe(Effect.flatMap((graph) => store.create(options.workspace, graph.config.profile ?? "smith")), Effect.flatMap((record) => opening.withPermits(1)(open(record)))),
    resume: (id: ConversationId) => ownRecord(id).pipe(Effect.flatMap((record) => opening.withPermits(1)(open(record)))),
    fork: (id: ConversationId, through: number) => ownRecord(id).pipe(Effect.zipRight(store.fork(id, through)), Effect.flatMap((record) => opening.withPermits(1)(open(record)))),
    list: store.list(options.workspace),
    graph: Ref.get(graphRef),
    reconfigure: (config: HarnessConfig, plugins?: ReadonlyArray<Plugin>) => Effect.gen(function* () {
      const registry = plugins ?? (yield* Ref.get(registryRef))
      const next = yield* resolveGraph(config, registry, [SessionEnvironment.key])
      if (graphFingerprint(next, "runtime") !== graphFingerprint(initial, "runtime")) return "restart-required" as const
      yield* Effect.forEach([...(yield* Ref.get(handles)).values()], (handle) => Effect.scoped(Effect.gen(function* () {
        const scope = yield* Effect.scope
        const seed = Context.add(runtime, SessionEnvironment, { workspace: options.workspace, session: handle.record })
        const context = yield* activateGraph(next, "session", Context.unsafeMake<never>(seed.unsafeMap), scope)
        yield* service(context, AgentLoop)
      })))
      yield* Ref.set(registryRef, registry)
      yield* Ref.set(graphRef, next)
      yield* Effect.forEach([...(yield* Ref.get(handles)).values()], (handle) => handle.busy.pipe(Effect.flatMap((active) => active ? Effect.void : handle.refresh)))
      return "applied" as const
    }),
  }
})

export const Harness = { make: makeHarness }
export type Harness = Effect.Effect.Success<ReturnType<typeof makeHarness>>
