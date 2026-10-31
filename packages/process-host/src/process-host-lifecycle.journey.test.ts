import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Stream } from "effect"
import type { Cause } from "effect"
import type { Scope } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { ConversationId, InboxItemId, InboxRunner, processActivity, RunId, SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, shutdownGracefully, TaskActivity, Tasks, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { SessionAddress, SessionCommitted } from "@xandreed/core"
import { Agent, agentInboxRunner, agentTaskExecutor } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksLive, tasksCapability, tasksDefaults } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { ProcessPeer } from "./ports/process-peer.port.js"
import { ProcessPeerError } from "./process-peer.entity.js"
import type { ProcessCommand, ProcessEvent } from "./process-protocol.entity.js"
import { ProcessRequestId } from "./process-protocol.entity.js"
import { serveProcess } from "./process-host.adapter.js"
import type { ProcessBinding, ProcessHostOptions, ProcessObservers } from "./process-host.entity.js"

const request = ProcessRequestId.make
const address: SessionAddress = { owner: "process-journey", id: ConversationId.make("00000000-0000-4000-8000-000000009001") }
const childId = ConversationId.make("00000000-0000-4000-8000-000000009002")
const query = { after: 0, kinds: [], limit: Option.none<number>() }
const message = (text: string) => new UserMessage({ text })
const hello: ProcessCommand = { _tag: "hello", requestId: request("hello"), protocolVersion: 1 }
const begin = (id = "begin"): ProcessCommand => ({ _tag: "begin", requestId: request(id), session: address, runId: RunId.make(id), userMessage: message("A private user instruction.") })
const shutdown: ProcessCommand = { _tag: "shutdown", requestId: request("shutdown"), deadlineMs: 0 }

const peerHarness = (fail?: (event: ProcessEvent) => boolean) => Effect.gen(function* () {
  const commands = yield* Queue.make<ProcessCommand, Cause.Done>({ capacity: 64 })
  const output = yield* Queue.make<ProcessEvent>({ capacity: 128 })
  const frames = yield* Ref.make<ReadonlyArray<ProcessEvent>>([])
  const peer = ProcessPeer.of({ commands: Stream.fromQueue(commands), flush: Effect.void,
    send: (event) => fail?.(event) === true ? Effect.fail(new ProcessPeerError({ direction: "output", reason: "Output", message: "fixture output failed" }))
      : Ref.update(frames, (all) => [...all, event]).pipe(Effect.andThen(Queue.offer(output, event)), Effect.asVoid),
  })
  const wait = (predicate: (event: ProcessEvent) => boolean) => Stream.fromQueue(output).pipe(Stream.filter(predicate), Stream.runHead, Effect.flatMap(Option.match({ onNone: () => Effect.die("fixture output ended"), onSome: Effect.succeed })))
  return { peer, frames: Ref.get(frames), command: (command: ProcessCommand) => Queue.offer(commands, command), eof: Queue.end(commands), wait }
})

const world = (observe: ProcessObservers, options: { readonly log?: (inner: Context.Service.Shape<typeof SessionLog>) => Context.Service.Shape<typeof SessionLog>; readonly model?: Effect.Effect<void>; readonly enqueue?: Effect.Effect<void>; readonly ask?: boolean; readonly maxPending?: number } = {}) => Effect.gen(function* () {
  const raw = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const sessionsContext = yield* Layer.build(SessionsLive({ ...sessionsDefaults, inbox: { ...sessionsDefaults.inbox, maxPending: options.maxPending ?? sessionsDefaults.inbox.maxPending } }).pipe(Layer.provideMerge(Layer.merge(Layer.succeed(SessionLog, observe.sessionLog(options.log?.(raw) ?? raw)), TurnAdmissionOpen))))
  const sessions = Context.get(sessionsContext, Sessions)
  yield* sessions.create(address)
  const calls = yield* Ref.make(0)
  const model = yield* LanguageModel.make({ generateText: () => Effect.gen(function* () {
    const index = yield* Ref.getAndUpdate(calls, (n) => n + 1)
    yield* (options.model ?? Effect.void)
    const parts: ReadonlyArray<Response.PartEncoded> = options.ask === true && index === 0
      ? [{ type: "tool-call", id: "ask-once", name: "ask_parent", params: { text: "Which accepted checkpoint?" } }, { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }]
      : [{ type: "text", text: "A public assistant reply." }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }]
    return [...parts]
  }), streamText: () => Stream.die("fixture does not stream") })
  const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], capabilities: [tasksCapability], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false } })
  const runner = observe.turnRunner(agent)
  const modelServices = Context.make(LanguageModel.LanguageModel, model)
  const tasksContext = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(Layer.succeedContext(sessionsContext), InProcessTaskRunnerLive(), agentTaskExecutor(runner, { services: modelServices, react: (turn) => turn.reply("The task finished.") })))))
  const tasks = Context.get(tasksContext, Tasks)
  const services = Context.merge(tasksContext, modelServices)
  const inbox = Context.get(yield* Layer.build(agentInboxRunner(runner, { services }).pipe(Layer.provide(Layer.succeed(Sessions, sessions)))), InboxRunner)
  const gate = options.enqueue
  const binding: ProcessBinding = { runner, services,
    use: (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))),
    sessions: gate === undefined ? sessions : { ...sessions, enqueue: (session, input) => gate.pipe(Effect.andThen(sessions.enqueue(session, input))) },
    tasks: Option.some(tasks), activity: processActivity.pipe(Effect.provide(services)), shutdown: (options) => shutdownGracefully(options).pipe(Effect.provide(services)),
  }
  return { binding, sessions, tasks, raw, calls: Ref.get(calls), idle: Context.get(tasksContext, TaskActivity).idle, inbox }
})
type World = Effect.Success<ReturnType<typeof world>>
const boot = (peer: Context.Service.Shape<typeof ProcessPeer>, setup: (observe: ProcessObservers) => Effect.Effect<World, unknown, Scope.Scope>, options: Partial<Pick<ProcessHostOptions, "maxBegins" | "maxShortCommands" | "onStopping">> = {}) => Effect.gen(function* () {
  const ready = yield* Deferred.make<World>()
  const running = yield* serveProcess({ owners: [address.owner], ...options, setup: (observe) => setup(observe).pipe(Effect.tap((env) => Deferred.succeed(ready, env)), Effect.map((env) => env.binding)) }).pipe(Effect.provideService(ProcessPeer, peer), Effect.exit, Effect.forkScoped)
  return { running, ready: Deferred.await(ready) }
})

describe("process host lifecycle and command dispatch", () => {
  test("hello and version are checked before setup, with safe fatal errors", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const setups = yield* Ref.make(0)
    const h = yield* peerHarness()
    yield* h.command({ ...hello, protocolVersion: 2 })
    const result = yield* serveProcess({ owners: [address.owner], setup: (observe) => Ref.update(setups, (n) => n + 1).pipe(Effect.andThen(world(observe)), Effect.map((env) => env.binding)) }).pipe(Effect.provideService(ProcessPeer, h.peer), Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* Ref.get(setups)).toBe(0)
    expect(yield* h.frames).toEqual([{ _tag: "error", requestId: request("hello"), code: "protocol.version", message: "the process protocol version is unsupported", fatal: true }])
  })).pipe(Effect.timeout("5 seconds"))))

  test("all four turn owners emit lifecycle only from their acknowledged rows", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, world)
    yield* h.command(hello)
    const env = yield* host.ready
    yield* h.command(begin())
    yield* h.wait((e) => e._tag === "begin.result")
    yield* h.command({ _tag: "send", requestId: request("queued"), session: address, input: { id: InboxItemId.make("borrowed"), userMessage: message("A queued message."), source: { source: "journey" } } })
    yield* h.wait((e) => e._tag === "queued")
    yield* env.sessions.drain(address, env.inbox.run, { take: "inputs" })
    yield* env.tasks.start(address, { taskId: childId, mode: "spawn", instructions: "A child task." })
    yield* env.idle
    const rows = [...yield* env.raw.read(address.id, query), ...yield* env.raw.read(childId, query)].filter((row) => row.kind === "turn.ended")
    const frames = yield* h.frames
    const endings = frames.filter((e) => e._tag === "turn.ended")
    expect(rows).toHaveLength(4)
    expect(endings).toHaveLength(4)
    rows.forEach((row) => expect(endings.filter((e) => e.session.id === row.session && e.turn === Option.getOrElse(row.turn, () => 0) && e.journal.seq === row.seq)).toHaveLength(1))
    expect(frames.filter((e) => e._tag === "turn.started")).toHaveLength(4)
    expect(yield* env.calls).toBe(3)
    expect(JSON.stringify(frames.filter((e) => e._tag === "turn.started" || e._tag === "turn.ended"))).not.toContain("private user")
    expect(frames.some((e) => e._tag === "turn.event" && e.progress.event._tag === "assistant.message")).toBe(true)
    yield* h.command(shutdown)
    expect(Exit.isSuccess(yield* Fiber.join(host.running))).toBe(true)
  })).pipe(Effect.timeout("10 seconds"))))

  test("an end stored without its ACK emits no terminal; releasing the ACK emits exactly once", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stored = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, (observe) => world(observe, { log: (inner) => ({ ...inner, commit: (id, commit) => inner.commit(id, commit).pipe(Effect.tap((receipt) => receipt.events.some((row) => row.kind === "turn.ended") ? Deferred.succeed(stored, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)) }) }))
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
    yield* h.command(hello)
    const env = yield* host.ready
    yield* h.command(begin())
    yield* Deferred.await(stored)
    expect((yield* env.raw.read(address.id, query)).filter((row) => row.kind === "turn.ended")).toHaveLength(1)
    expect((yield* h.frames).filter((e) => e._tag === "turn.ended")).toHaveLength(0)
    yield* h.command({ _tag: "ping", requestId: request("during-ack") })
    yield* h.wait((e) => e._tag === "pong")
    yield* Deferred.succeed(release, undefined)
    yield* h.wait((e) => e._tag === "begin.result")
    expect((yield* h.frames).filter((e) => e._tag === "turn.ended")).toHaveLength(1)
    yield* h.command(shutdown)
    expect(Exit.isSuccess(yield* Fiber.join(host.running))).toBe(true)
  })).pipe(Effect.timeout("10 seconds"))))

  test("a lost end ACK is visible in storage and never fabricated on the wire", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, (observe) => world(observe, { log: (inner) => ({ ...inner, commit: (id, commit) => inner.commit(id, commit).pipe(Effect.flatMap((receipt) => receipt.events.some((row) => row.kind === "turn.ended") ? Effect.fail(new SessionLogError({ code: "store.io", message: "fixture lost the end ACK" })) : Effect.succeed(receipt))) }) }))
    yield* h.command(hello)
    const env = yield* host.ready
    yield* h.command(begin())
    expect(Exit.isFailure(yield* Fiber.join(host.running))).toBe(true)
    expect((yield* env.raw.read(address.id, query)).filter((row) => row.kind === "turn.ended")).toHaveLength(1)
    expect((yield* h.frames).filter((e) => e._tag === "turn.ended")).toHaveLength(0)
    expect(yield* env.calls).toBe(1)
  })).pipe(Effect.timeout("10 seconds"))))

  test("post-ACK output failure preserves the original receipt and completed result", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const receipt = yield* Ref.make<Option.Option<SessionCommitted>>(Option.none())
    const h = yield* peerHarness((e) => e._tag === "turn.ended")
    const host = yield* boot(h.peer, (observe) => world(observe, { log: (inner) => ({ ...inner, commit: (id, commit) => inner.commit(id, commit).pipe(Effect.tap((value) => value.events.some((row) => row.kind === "turn.ended") ? Ref.set(receipt, Option.some(value)) : Effect.void)) }) }))
    yield* h.command(hello)
    const env = yield* host.ready
    yield* h.command(begin())
    expect(Exit.isFailure(yield* Fiber.join(host.running))).toBe(true)
    expect(Option.isSome(yield* Ref.get(receipt))).toBe(true)
    expect((yield* env.raw.read(address.id, query)).filter((row) => row.kind === "turn.ended").map((row) => row.data.reason)).toEqual(["completed"])
    const result = (yield* h.frames).find((e) => e._tag === "begin.result")
    expect(result?._tag === "begin.result" ? result.result.outcome : "missing").toBe("completed")
    expect(yield* env.calls).toBe(1)
  })).pipe(Effect.timeout("10 seconds"))))

  test("active begins preserve control capacity and durable input through cancel", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const called = yield* Deferred.make<void>()
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, (observe) => world(observe, { model: Deferred.succeed(called, undefined).pipe(Effect.andThen(Effect.never)) }), { maxBegins: 1 })
    yield* h.command(hello)
    const env = yield* host.ready
    yield* h.command(begin())
    yield* Deferred.await(called)
    yield* h.command(begin("excess"))
    const busy = yield* h.wait((e) => e._tag === "error" && e.requestId === request("excess"))
    expect(busy._tag === "error" && busy.code).toBe("host.busy")
    yield* h.command({ _tag: "send", requestId: request("send"), session: address, input: { id: InboxItemId.make("next"), userMessage: message("Keep the next message."), source: {} } })
    yield* h.wait((e) => e._tag === "queued")
    yield* h.command({ _tag: "steer", requestId: request("steer"), session: address, input: { id: InboxItemId.make("steer"), userMessage: message("Keep this steer."), source: {} } })
    yield* h.wait((e) => e._tag === "queued" && e.requestId === request("steer"))
    yield* h.command({ _tag: "ping", requestId: request("reuse") })
    const ping = yield* h.wait((e) => e._tag === "pong")
    expect(ping._tag === "pong" && ping.activity.inFlight).toBe(true)
    yield* h.command({ _tag: "ping", requestId: request("reuse") })
    yield* h.wait((e) => e._tag === "pong")
    yield* h.command({ _tag: "send", requestId: request("foreign"), session: { ...address, owner: "another-owner" }, input: { id: InboxItemId.make("refused"), userMessage: message("Never admit this."), source: {} } })
    const refused = yield* h.wait((e) => e._tag === "error" && e.requestId === request("foreign"))
    expect(refused._tag === "error" && refused.code).toBe("host.owner")
    yield* h.command({ _tag: "cancel", requestId: request("cancel"), session: address, turn: 1 })
    yield* h.wait((e) => e._tag === "cancelled")
    expect((yield* env.sessions.get(address)).pending).toBe(2)
    expect((yield* env.raw.read(address.id, query)).filter((row) => row.kind === "turn.started")).toHaveLength(1)
    yield* h.command(shutdown)
    expect(Exit.isSuccess(yield* Fiber.join(host.running))).toBe(true)
  })).pipe(Effect.timeout("10 seconds"))))

  test("short command saturation leaves a control lane and rejects before storage", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, (observe) => world(observe, { enqueue: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) }), { maxShortCommands: 1 })
    yield* h.command(hello)
    const env = yield* host.ready
    const input = { id: InboxItemId.make("held"), userMessage: message("Accepted input."), source: {} }
    yield* h.command({ _tag: "send", requestId: request("held"), session: address, input })
    yield* Deferred.await(entered)
    yield* h.command({ _tag: "send", requestId: request("excess"), session: address, input: { ...input, id: InboxItemId.make("not-admitted") } })
    const busy = yield* h.wait((e) => e._tag === "error" && e.requestId === request("excess"))
    expect(busy._tag === "error" && busy.code).toBe("host.busy")
    yield* h.command({ _tag: "ping", requestId: request("control") })
    yield* h.wait((e) => e._tag === "pong")
    expect((yield* env.sessions.get(address)).pending).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* h.wait((e) => e._tag === "queued")
    expect((yield* env.sessions.get(address)).pending).toBe(1)
    yield* h.command(shutdown)
    expect(Exit.isSuccess(yield* Fiber.join(host.running))).toBe(true)
  })).pipe(Effect.timeout("10 seconds"))))

  test("duplicate active IDs fail safely without dispatching the duplicate", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const called = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const stopping = yield* Deferred.make<void>()
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, (observe) => world(observe, { model: Deferred.succeed(called, undefined).pipe(Effect.andThen(Deferred.await(release))) }), { onStopping: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid) })
    yield* h.command(hello)
    const env = yield* host.ready
    yield* h.command(begin())
    yield* Deferred.await(called)
    yield* h.command({ _tag: "ping", requestId: request("begin") })
    yield* Deferred.await(stopping)
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.join(host.running))).toBe(true)
    expect((yield* h.frames).filter((e) => e._tag === "pong")).toHaveLength(0)
    expect((yield* h.frames).some((e) => e._tag === "error" && e.fatal && e.code === "protocol.sequence")).toBe(true)
    expect(yield* env.calls).toBe(1)
  })).pipe(Effect.timeout("10 seconds"))))

  test("clean EOF after hello shuts down the captured runtime", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, world)
    yield* h.command(hello)
    yield* host.ready
    yield* h.eof
    const result = yield* Fiber.join(host.running)
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) { expect(result.value.reason).toBe("eof"); expect(Option.isSome(result.value.report)).toBe(true) }
  })).pipe(Effect.timeout("10 seconds"))))

  test("wire answers preserve durable deferred, exact duplicate and terminal semantics", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const called = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const h = yield* peerHarness()
    const host = yield* boot(h.peer, (observe) => world(observe, { ask: true, maxPending: 1, model: Deferred.succeed(called, undefined).pipe(Effect.andThen(Deferred.await(release))) }))
    yield* h.command(hello)
    const env = yield* host.ready
    yield* env.tasks.start(address, { taskId: childId, mode: "spawn", instructions: "Ask which checkpoint to use." })
    yield* Deferred.await(called)
    const child = { owner: address.owner, id: childId }
    yield* env.sessions.enqueue(child, { id: InboxItemId.make("old-steer"), delivery: "steer", userMessage: message("Preserve this earlier steer."), source: {} })
    yield* Deferred.succeed(release, undefined)
    yield* env.idle
    const task = yield* env.tasks.status(address, childId)
    expect(task.status).toBe("waiting")
    if (task.question === undefined) return yield* Effect.die("the real helper did not ask")
    const answer = { _tag: "answer" as const, parent: address, taskId: childId, questionId: task.question.questionId, text: "Use the committed checkpoint." }
    yield* h.command({ ...answer, requestId: request("answer-one") })
    const deferred = yield* h.wait((e) => e._tag === "answered")
    expect(deferred).toEqual({ _tag: "answered", requestId: request("answer-one"), accepted: true, enqueued: false })
    yield* h.command({ ...answer, requestId: request("answer-two") })
    expect(yield* h.wait((e) => e._tag === "answered")).toEqual({ _tag: "answered", requestId: request("answer-two"), accepted: true, enqueued: false })
    expect((yield* env.sessions.read(child, { kinds: ["task.answered"] })).length).toBe(1)
    yield* env.sessions.drain(child, env.tasks.execute, { take: "inputs", maxTurns: 1 })
    expect(yield* env.calls).toBe(1)
    yield* h.command({ ...answer, requestId: request("answer-pending") })
    expect(yield* h.wait((e) => e._tag === "answered")).toEqual({ _tag: "answered", requestId: request("answer-pending"), accepted: true, enqueued: true })
    yield* env.tasks.reconcile(address)
    yield* h.command({ ...answer, requestId: request("answer-already-queued") })
    expect(yield* h.wait((e) => e._tag === "answered")).toEqual({ _tag: "answered", requestId: request("answer-already-queued"), accepted: true, enqueued: false })
    expect((yield* env.sessions.get(child)).pending).toBe(1)
    yield* env.sessions.drain(child, env.tasks.execute, { take: "inputs", maxTurns: 1 })
    expect((yield* env.tasks.status(address, childId)).status).toBe("completed")
    yield* h.command({ ...answer, requestId: request("answer-retired") })
    expect(yield* h.wait((e) => e._tag === "answered")).toEqual({ _tag: "answered", requestId: request("answer-retired"), accepted: true, enqueued: false })
    yield* h.command({ ...answer, text: "Change the accepted answer.", requestId: request("answer-conflict") })
    const conflict = yield* h.wait((e) => e._tag === "error" && e.requestId === request("answer-conflict"))
    expect(conflict._tag === "error" && conflict.code).toBe("host.command")
    expect(yield* env.calls).toBe(2)
    expect((yield* env.sessions.read(child, { kinds: ["task.answered"] })).length).toBe(1)
    expect((yield* env.sessions.get(child)).pending).toBe(0)
    yield* h.command(shutdown)
    expect(Exit.isSuccess(yield* Fiber.join(host.running))).toBe(true)
  })).pipe(Effect.timeout("10 seconds"))))

  test("onStopping runs once before failed setup's uninterruptible finalizer", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const notified = yield* Ref.make(0)
    const h = yield* peerHarness()
    const host = yield* serveProcess({ owners: [address.owner], onStopping: Ref.update(notified, (n) => n + 1), setup: () => Effect.addFinalizer(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.uninterruptible)).pipe(Effect.andThen(Effect.fail("private setup error"))) }).pipe(Effect.provideService(ProcessPeer, h.peer), Effect.exit, Effect.forkScoped)
    yield* h.command(hello)
    yield* Deferred.await(entered)
    expect(yield* Ref.get(notified)).toBe(1)
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.join(host))).toBe(true)
    expect(JSON.stringify(yield* h.frames)).not.toContain("private setup error")
  })).pipe(Effect.timeout("10 seconds"))))
})
