import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect"
import {
  ConversationId, entriesOfEvents, HarnessError, InboxItemId, mediaFromBase64, RunId,
  SessionLog, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import type { QueuedInput, SessionAddress, SessionLogEvent, Turn, TurnError, TurnOutcome } from "@xandreed/core"
import { textReply } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

type SessionService = Context.Service.Shape<typeof Sessions>
const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const queued = (id: string, text = id, delivery: QueuedInput["delivery"] = "steer"): QueuedInput => ({
  id: InboxItemId.make(id), userMessage: new UserMessage({ text }), delivery, source: { channel: "journey" },
})
const environment = (id: string) => Effect.gen(function* () {
  const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const reopen = () => Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
  )).pipe(Effect.map(Context.get(Sessions)))
  const sessions = yield* reopen()
  const address: SessionAddress = { owner: "durable-steering-journey", id: ConversationId.make(id) }
  yield* sessions.create(address)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 4 },
  })
  return { sessions, address, agent, reopen }
})
const provider = (reply: (index: number) => Effect.Effect<ReadonlyArray<Response.PartEncoded>>) => Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<ReadonlyArray<Prompt.Message>>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(requests, (all): readonly [number, ReadonlyArray<ReadonlyArray<Prompt.Message>>] => [all.length, [...all, options.prompt.content]]).pipe(
      Effect.flatMap(reply), Effect.map((parts) => [...parts]),
    ),
    streamText: () => Stream.die("not scripted"),
  })
  return { model, requests: Ref.get(requests) }
})
const services = (sessions: SessionService, model: LanguageModel.LanguageModel) => Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, model))
const runAnswer = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) })))
const users = (messages: ReadonlyArray<Prompt.Message>) => messages.filter((message) => message.role === "user")
const userText = (messages: ReadonlyArray<Prompt.Message>) => users(messages).map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))
const taken = (events: ReadonlyArray<SessionLogEvent>) => events.filter((event) => event.kind === "inbox.taken")

describe("journey: durable steering", () => {
  test("steers arriving during a final response continue after true completion as separate messages, and next input waits for its own turn", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { sessions, address, agent } = yield* environment("00000000-0000-4000-8000-000000005521")
    const requested = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const script = yield* provider((index) => index === 0
      ? Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(textReply("initial answer")))
      : Effect.succeed(textReply(index === 1 ? "updated answer" : "next answer")))
    const completions = yield* Ref.make(0)
    const asking = yield* Effect.forkChild(agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: "original request" }), runId: RunId.make("steered-run") }, services: services(sessions, script.model),
    }, (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({
      completion: () => Ref.update(completions, (n) => n + 1).pipe(Effect.as({ complete: true, awaiting: [], facts: {} })),
    })), Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) })))))
    yield* Deferred.await(requested)
    const image = yield* mediaFromBase64(pixelPng, { name: "steer.png" })
    const imageInput = { ...queued("image-steer"), userMessage: new UserMessage({ text: "inspect this image", attachments: [image] }) }
    yield* sessions.enqueue(address, queued("text-steer", "change the focus"))
    yield* sessions.enqueue(address, imageInput)
    yield* sessions.enqueue(address, queued("next-input", "a separate request", "next"))
    yield* Deferred.succeed(release, undefined)
    const done = yield* Fiber.join(asking)
    const beforeNext = yield* sessions.get(address)
    const beforeEvents = yield* sessions.read(address)
    const entries = yield* entriesOfEvents(beforeEvents)
    const inputs = entries.filter((entry) => entry.body._tag === "Message" && entry.body.inbox !== undefined)
    expect(done.outcome).toBe("completed")
    expect(yield* Ref.get(completions)).toBe(2)
    expect(beforeNext.pending).toBe(1)
    expect(taken(beforeEvents).map((event) => event.data.id)).toEqual(["text-steer", "image-steer"])
    expect(inputs.map((entry) => ({ id: String(entry.id), run: entry.body._tag === "Message" ? Number(entry.body.run) : -1, step: entry.step }))).toEqual(
      taken(beforeEvents).map((event) => ({ id: String(event.data.entry), run: 0, step: 1 })),
    )
    const firstStep = beforeEvents.find((event) => event.kind === "step.started" && event.data.step === 1)!
    expect(inputs.every((entry) => beforeEvents.find((event) => event.kind === "memory.message" && event.data.entry === entry.id)!.seq > firstStep.seq)).toBe(true)
    const prompts = yield* script.requests
    expect(prompts).toHaveLength(2)
    expect(userText(prompts[0]!)).toEqual(["original request"])
    expect(users(prompts[1]!)).toMatchObject([
      { content: [{ type: "text", text: "original request" }] },
      { content: [{ type: "text", text: "change the focus" }] },
      { content: [{ type: "file", mediaType: "image/png", data: pixelPng, fileName: "steer.png" }, { type: "text", text: "inspect this image" }] },
    ])
    const writer = yield* sessions.begin(address, { _tag: "Queued", input: InboxItemId.make("next-input"), runId: RunId.make("next-run") })
    expect(writer.admitted).toMatchObject({ origin: "user", claimed: [], input: queued("next-input", "a separate request", "next") })
    const next = yield* agent.turn({ turn: writer, services: services(sessions, script.model) }, runAnswer)
    yield* writer.end({ reason: next.outcome, failure: Option.none() })
    expect((yield* sessions.get(address)).pending).toBe(0)
    expect(taken(yield* sessions.read(address))).toHaveLength(2)
  })).pipe(Effect.timeout("4 seconds"))))

  test("a reopened interrupted root consumes an already queued steer before its first provider request", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { sessions, address, agent, reopen } = yield* environment("00000000-0000-4000-8000-000000005522")
    const root = yield* sessions.begin(address, { _tag: "User", runId: RunId.make("old-root"), key: "root", command: {}, userMessage: new UserMessage({ text: "unfinished request" }) })
    yield* root.end({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "the holder stopped" }) })
    yield* sessions.enqueue(address, queued("restart-steer", "use the new instruction"))
    const successor = yield* reopen()
    const script = yield* provider(() => Effect.succeed(textReply("resumed")))
    const result = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "Continue." }), runId: RunId.make("resumed-root"), resumes: 1 }, services: services(successor, script.model) }, runAnswer)
    const events = yield* successor.read(address)
    const entries = yield* entriesOfEvents(events)
    expect(result.outcome).toBe("completed")
    expect(userText((yield* script.requests)[0]!)).toEqual(["unfinished request", "Continue.", "use the new instruction"])
    expect(taken(events)).toHaveLength(1)
    expect(Option.getOrElse(taken(events)[0]!.turn, () => -1)).toBe(2)
    expect(entries.filter((entry) => entry.body._tag === "Message" && entry.body.inbox === "restart-steer").map((entry) => [entry.turn, entry.step])).toEqual([[2, 0]])
    expect((yield* successor.get(address)).pending).toBe(0)
  })).pipe(Effect.timeout("4 seconds"))))

  test("the step cap leaves a final response's pending steer untouched without starting or recording an extra step", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { sessions, address, agent } = yield* environment("00000000-0000-4000-8000-000000005523")
    const requested = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const script = yield* provider(() => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(textReply("first answer"))))
    const asking = yield* Effect.forkChild(agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "first request" }), runId: RunId.make("capped") }, services: services(sessions, script.model) }, (turn) =>
      turn.run({ limits: { maxSteps: 1 }, completion: () => Effect.succeed({ complete: true, awaiting: [], facts: {} }) }).pipe(Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) })))))
    yield* Deferred.await(requested)
    yield* sessions.enqueue(address, queued("left-at-cap", "more work"))
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(asking)
    const events = yield* sessions.read(address)
    expect(result.outcome).toBe("partial")
    expect((yield* sessions.get(address)).pending).toBe(1)
    expect(yield* script.requests).toHaveLength(1)
    expect(taken(events)).toHaveLength(0)
    expect(events.filter((event) => event.kind === "step.started").map((event) => event.data.step)).toEqual([0])
    expect((yield* entriesOfEvents(events)).some((entry) => entry.body._tag === "Message" && entry.body.inbox !== undefined)).toBe(false)
  })).pipe(Effect.timeout("4 seconds"))))

  test("an input enqueued after the final empty probe waits for one separate queued turn", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { sessions, address, agent } = yield* environment("00000000-0000-4000-8000-000000005524")
    const answered = yield* Ref.make(false)
    const armed = yield* Ref.make(true)
    const late = queued("late-steer", "arrived after the empty probe")
    const wrapped = Sessions.of({ ...sessions, begin: (session, input) => sessions.begin(session, input).pipe(Effect.map((writer) => ({
      ...writer, steers: writer.steers.pipe(Effect.tap((inputs) => Ref.get(answered).pipe(Effect.flatMap((pastResponse) => !pastResponse || inputs.length > 0
        ? Effect.void : Ref.getAndSet(armed, false).pipe(Effect.flatMap((first) => first ? sessions.enqueue(address, late).pipe(Effect.orDie, Effect.asVoid) : Effect.void)))))),
    }))) })
    const script = yield* provider(() => Ref.set(answered, true).pipe(Effect.as(textReply("done"))))
    const result = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "first" }), runId: RunId.make("empty-probe") }, services: services(wrapped, script.model) }, runAnswer)
    expect(result.outcome).toBe("completed")
    expect((yield* sessions.get(address)).pending).toBe(1)
    expect(yield* script.requests).toHaveLength(1)
    expect(taken(yield* sessions.read(address))).toHaveLength(0)
    const drained = yield* sessions.drain(address, (writer) => agent.turn({ turn: writer, services: services(sessions, script.model) }, runAnswer).pipe(Effect.asVoid), { take: "inputs", maxTurns: 1 })
    expect(drained.turns).toBe(1)
    expect((yield* sessions.get(address)).pending).toBe(0)
    expect(yield* script.requests).toHaveLength(2)
    expect((yield* sessions.read(address)).filter((event) => event.kind === "turn.started").map((event) => event.data.input ?? null)).toEqual([null, "late-steer"])
  })).pipe(Effect.timeout("4 seconds"))))

  test("two concurrent Turn.run calls contend over one input and record one receipt and one user message", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { sessions, address, agent } = yield* environment("00000000-0000-4000-8000-000000005525")
    yield* sessions.enqueue(address, queued("shared-steer", "one shared instruction"))
    const reads = yield* Ref.make(0)
    const both = yield* Deferred.make<void>()
    const wrapped = Sessions.of({ ...sessions, begin: (session, input) => sessions.begin(session, input).pipe(Effect.map((writer) => ({
      ...writer, steers: writer.steers.pipe(Effect.tap((inputs) => inputs.length === 0 ? Effect.void : Ref.getAndUpdate(reads, (n) => n + 1).pipe(
        Effect.flatMap((index) => index > 1 ? Effect.void : (index === 1 ? Deferred.succeed(both, undefined) : Effect.void).pipe(Effect.andThen(Deferred.await(both)))),
      ))),
    }))) })
    const script = yield* provider(() => Effect.succeed(textReply("done")))
    const result = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "run both" }), runId: RunId.make("parallel-steering") }, services: services(wrapped, script.model) }, (turn): Effect.Effect<TurnOutcome, TurnError> => turn.tools.select(turn.userMessage).pipe(
      Effect.andThen(Effect.all([turn.run<never>({}), turn.run<never>({})], { concurrency: 2 })), Effect.as({ outcome: "completed" as const, reply: Option.some("both finished") }),
    ))
    const events = yield* sessions.read(address)
    const entries = yield* entriesOfEvents(events)
    expect(result.outcome).toBe("completed")
    expect(taken(events)).toHaveLength(1)
    expect(entries.filter((entry) => entry.body._tag === "Message" && entry.body.inbox === "shared-steer")).toHaveLength(1)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    expect(yield* script.requests).toHaveLength(2)
    expect((yield* script.requests).map((prompt) => userText(prompt).filter((text) => text === "one shared instruction").length)).toEqual([1, 1])
    expect((yield* sessions.get(address)).pending).toBe(0)
  })).pipe(Effect.timeout("4 seconds"))))

  test.each(["refuse", "ack-loss"] as const)("a steering %s fails before dispatch and replay retains each actually committed instruction once", (mode) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { sessions, address, agent } = yield* environment(mode === "refuse" ? "00000000-0000-4000-8000-000000005526" : "00000000-0000-4000-8000-000000005527")
    yield* sessions.enqueue(address, queued("uncertain-steer", "apply this instruction"))
    const armed = yield* Ref.make(true)
    const error = new HarnessError({ code: "memory.log", message: mode === "refuse" ? "the steering write was refused" : "the steering acknowledgement was lost" })
    const wrapped = Sessions.of({ ...sessions, begin: (session, input) => sessions.begin(session, input).pipe(Effect.map((writer) => ({
      ...writer, take: (entries) => Ref.getAndSet(armed, false).pipe(Effect.flatMap((first) => !first ? writer.take(entries)
        : mode === "refuse" ? Effect.fail(error) : writer.take(entries).pipe(Effect.andThen(Effect.fail(error))))),
    }))) })
    const script = yield* provider(() => Effect.succeed(textReply("done")))
    const failed = yield* Effect.exit(agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "start" }), runId: RunId.make(`steer-${mode}`) }, services: services(wrapped, script.model) }, runAnswer))
    const after = yield* sessions.read(address)
    expect(Exit.findErrorOption(failed)).toEqual(Option.some(error))
    expect(yield* script.requests).toHaveLength(0)
    expect(taken(after)).toHaveLength(mode === "refuse" ? 0 : 1)
    expect((yield* sessions.get(address)).pending).toBe(mode === "refuse" ? 1 : 0)
    const result = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "continue after the stop" }), runId: RunId.make(`after-${mode}`) }, services: services(wrapped, script.model) }, runAnswer)
    const events = yield* sessions.read(address)
    const entries = yield* entriesOfEvents(events)
    expect(result.outcome).toBe("completed")
    expect(userText((yield* script.requests)[0]!).filter((text) => text === "apply this instruction")).toHaveLength(1)
    expect(taken(events)).toHaveLength(1)
    expect(entries.filter((entry) => entry.body._tag === "Message" && entry.body.inbox === "uncertain-steer")).toHaveLength(1)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    expect((yield* sessions.get(address)).pending).toBe(0)
  })).pipe(Effect.timeout("4 seconds"))))
})
