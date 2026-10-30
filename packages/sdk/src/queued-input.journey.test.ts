import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import type { Prompt } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import {
  ConversationId,
  InboxItemId,
  MediaFingerprint,
  mediaFromBase64,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { AdmittedTurn, SessionAddress, Turn } from "@xandreed/core"
import { textReply } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const sessionsFor = (id: string) => Effect.gen(function* () {
  const services = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
  ))
  const sessions = Context.get(services, Sessions)
  const address: SessionAddress = { owner: "queued-input-journey", id: ConversationId.make(id) }
  yield* sessions.create(address)
  return { sessions, address }
})

const agentFor = () => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  turnServices: [LanguageModel.LanguageModel],
  limits: { streaming: false, maxSteps: 2 },
})

/** Capture the exact provider request, including normalized file parts. */
const modelFor = (answer: string, blocked?: Deferred.Deferred<void>) => Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<ReadonlyArray<Prompt.Message>>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.update(requests, (all) => [...all, options.prompt.content]).pipe(
      Effect.andThen(blocked === undefined ? Effect.succeed([...textReply(answer)]) : Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))),
    ),
    streamText: () => Stream.die("not scripted"),
  })
  return { model, requests: Ref.get(requests) }
})

const runAnswer = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({})),
  Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

describe("journey: queued user inputs", () => {
  test("a queued writer gives Agent.turn one normalized user message with its attachment and no claimed notice", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, address } = yield* sessionsFor("00000000-0000-4000-8000-000000005511")
      const agent = yield* agentFor()
      const provider = yield* modelFor("I can see the queued image.")
      const pixel = yield* mediaFromBase64(pixelPng, { name: "queued.png", alt: "one pixel" })
      const normalized = new UserMessage({ text: "Inspect the queued image.", attachments: [pixel] })
      const source = { channel: "user-upload", privateMarker: "queue-source-hidden" }
      const queued = { id: InboxItemId.make("uploaded-image"), delivery: "next" as const, source, userMessage: new UserMessage({
        text: normalized.text, attachments: [{ ...pixel, mediaType: "image/webp", bytes: 9, fingerprint: MediaFingerprint.make("ffffffffffffffff") }],
      }) }
      const first = yield* sessions.enqueue(address, queued)
      const duplicate = yield* sessions.enqueue(address, { ...queued, userMessage: normalized })
      const writer = yield* sessions.begin(address, { _tag: "Queued", input: queued.id, runId: RunId.make("queued-image"), meta: { request: "queue-host-meta" } })
      const result = yield* agent.turn({
        turn: writer, services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, provider.model)),
      }, runAnswer)
      const ended = yield* writer.end({ reason: result.outcome, failure: Option.none() })
      const retry = yield* Effect.flip(sessions.begin(address, { _tag: "Queued", input: queued.id, runId: RunId.make("queued-image") }))
      return { first, duplicate, normalized, queued, admitted: writer.admitted, result, ended, retry, requests: yield* provider.requests, events: yield* sessions.read(address), view: yield* sessions.get(address) }
    })))

    expect(observed.first).toEqual({ enqueued: true, pending: 1 })
    expect(observed.duplicate).toEqual({ enqueued: false, pending: 1 })
    expect(observed.admitted).toMatchObject({
      origin: "user", key: "input:uploaded-image", userMessage: observed.normalized, command: {}, claimed: [],
      input: { ...observed.queued, userMessage: observed.normalized }, meta: { request: "queue-host-meta" },
    })
    expect(observed.admitted.task).toBeUndefined()
    expect(observed.result).toMatchObject({ outcome: "completed", reply: Option.some("I can see the queued image.") })
    expect(observed.result.pending).toBeUndefined()
    expect(observed.ended).toEqual({ pending: 0 })
    expect(observed.retry).toMatchObject({ _tag: "TurnDuplicate", turn: 1, open: false })
    expect(observed.view.pending).toBe(0)
    expect(observed.requests).toHaveLength(1)
    expect(observed.requests[0]?.filter((message) => message.role === "user")).toMatchObject([{
      role: "user", content: [
        { type: "file", mediaType: "image/png", data: pixelPng, fileName: "queued.png" },
        { type: "text", text: "Inspect the queued image." },
      ],
    }])
    expect(JSON.stringify(observed.requests)).not.toContain("queue-source-hidden")
    expect(JSON.stringify(observed.requests)).not.toContain("queue-host-meta")
    const storedMessage = { text: observed.normalized.text, attachments: observed.normalized.attachments }
    const queued = observed.events.filter((event) => event.kind === "inbox.queued")
    expect(queued).toHaveLength(1)
    expect(queued[0]?.data).toMatchObject({ id: "uploaded-image", source: observed.queued.source, content: "", input: { userMessage: storedMessage, delivery: "next" } })
    expect(observed.events.filter((event) => event.kind === "turn.started").map((event) => event.data)).toMatchObject([{
      origin: "user", input: "uploaded-image", userMessage: storedMessage, claimed: [], command: {},
    }])
    expect(observed.events.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["completed"])
  })

  test("interrupting a queued root then manually resuming it acknowledges its input without another input drain", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, address } = yield* sessionsFor("00000000-0000-4000-8000-000000005512")
      const agent = yield* agentFor()
      const requested = yield* Deferred.make<void>()
      const first = yield* modelFor("unreachable", requested)
      const queued = { id: InboxItemId.make("interrupted-input"), delivery: "steer" as const, source: { channel: "user-chat" }, userMessage: new UserMessage({ text: "Finish the queued request." }) }
      yield* sessions.enqueue(address, queued)
      const asking = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
        const writer = yield* sessions.begin(address, { _tag: "Queued", input: queued.id, runId: RunId.make("queued-interrupted") })
        return yield* agent.turn({
          turn: writer, services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, first.model)),
        }, runAnswer)
      })))
      yield* Deferred.await(requested)
      yield* Fiber.interrupt(asking)
      const afterInterrupt = yield* sessions.get(address)
      const interruptedEvents = yield* sessions.read(address)

      const resumedAdmitted = yield* Ref.make(Option.none<AdmittedTurn>())
      const duringResume = yield* Ref.make(-1)
      const second = yield* modelFor("The queued request is finished.")
      const services = Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, second.model))
      const result = yield* agent.turn({
        turn: { session: address, userMessage: new UserMessage({ text: "Continue the queued request." }), runId: RunId.make("queued-resumed"), resumes: 1 }, services,
      }, (turn) => Ref.set(resumedAdmitted, Option.some(turn.admitted)).pipe(
        Effect.andThen(sessions.get(address).pipe(Effect.orDie)), Effect.flatMap((view) => Ref.set(duringResume, view.pending)), Effect.andThen(runAnswer(turn)),
      ))
      const drainCalls = yield* Ref.make(0)
      const drained = yield* sessions.drain(address, (writer) => Ref.update(drainCalls, (count) => count + 1).pipe(
        Effect.andThen(agent.turn({ turn: writer, services }, runAnswer)), Effect.asVoid,
      ), { take: "inputs" })
      return {
        queued, afterInterrupt, interruptedEvents, result, admitted: yield* Ref.get(resumedAdmitted), duringResume: yield* Ref.get(duringResume),
        drained, drainCalls: yield* Ref.get(drainCalls), requests: yield* second.requests, events: yield* sessions.read(address), view: yield* sessions.get(address),
      }
    })))

    expect(observed.afterInterrupt.pending).toBe(1)
    expect(Option.isNone(observed.afterInterrupt.open)).toBe(true)
    expect(observed.interruptedEvents.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["interrupted"])
    expect(observed.admitted).toMatchObject(Option.some({ origin: "user", resumes: 1, claimed: [], input: observed.queued }))
    expect(observed.duringResume).toBe(0)
    expect(observed.result).toMatchObject({ outcome: "completed", reply: Option.some("The queued request is finished."), pending: 0 })
    expect(observed.view.pending).toBe(0)
    expect(observed.drained).toEqual({ turns: 0 })
    expect(observed.drainCalls).toBe(0)
    expect(observed.requests).toHaveLength(1)
    expect(observed.requests[0]?.filter((message) => message.role === "user").map((message) => message.content)).toMatchObject([
      [{ type: "text", text: "Finish the queued request." }], [{ type: "text", text: "Continue the queued request." }],
    ])
    expect(observed.events.filter((event) => event.kind === "turn.started").map((event) => ({ turn: Option.getOrElse(event.turn, () => -1), origin: event.data.origin, input: event.data.input, claimed: event.data.claimed }))).toEqual([
      { turn: 1, origin: "user", input: "interrupted-input", claimed: [] }, { turn: 2, origin: "user", input: "interrupted-input", claimed: [] },
    ])
    expect(observed.events.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["interrupted", "completed"])
    expect(observed.events.filter((event) => event.kind === "inbox.queued")).toHaveLength(1)
    expect(observed.events.filter((event) => event.kind === "inbox.dropped")).toHaveLength(0)
    expect(observed.view.turns).toBe(2)
  })

  test("a drained Agent run that reaches its step cap retains the input until a later run completes it", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, address } = yield* sessionsFor("00000000-0000-4000-8000-000000005513")
      const agent = yield* agentFor()
      const queued = { id: InboxItemId.make("partial-input"), delivery: "next" as const, source: {}, userMessage: new UserMessage({ text: "Finish the work after loading its tools." }) }
      yield* sessions.enqueue(address, queued)
      const incomplete = yield* LanguageModel.make({
        generateText: () => Effect.succeed([
          { type: "tool-call", id: "load-tools", name: "load_skill", params: { skills: [] }, providerExecuted: false },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } } },
        ]),
        streamText: () => Stream.die("not scripted"),
      })
      const outcomes = yield* Ref.make<ReadonlyArray<string>>([])
      const partial = yield* sessions.drain(address, (writer) => agent.turn({
        turn: writer, services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, incomplete)),
      }, (turn) => turn.tools.select(turn.userMessage).pipe(
        Effect.andThen(turn.run({ limits: { maxSteps: 1 } })), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) })),
      )).pipe(Effect.tap((result) => Ref.update(outcomes, (all) => [...all, result.outcome])), Effect.asVoid), { take: "inputs", maxTurns: 1 })
      const afterPartial = yield* sessions.get(address)
      const partialEvents = yield* sessions.read(address)
      const complete = yield* modelFor("The remaining work is complete.")
      const completed = yield* sessions.drain(address, (writer) => agent.turn({
        turn: writer, services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, complete.model)),
      }, runAnswer).pipe(Effect.tap((result) => Ref.update(outcomes, (all) => [...all, result.outcome])), Effect.asVoid), { take: "inputs", maxTurns: 1 })
      return { partial, afterPartial, partialEvents, completed, outcomes: yield* Ref.get(outcomes), events: yield* sessions.read(address), view: yield* sessions.get(address) }
    })))

    expect(observed.partial).toEqual({ turns: 1 })
    expect(observed.afterPartial.pending).toBe(1)
    expect(observed.partialEvents.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["partial"])
    expect(observed.completed).toEqual({ turns: 1 })
    expect(observed.outcomes).toEqual(["partial", "completed"])
    expect(observed.view.pending).toBe(0)
    expect(observed.events.filter((event) => event.kind === "turn.started").map((event) => ({ input: event.data.input, claimed: event.data.claimed }))).toEqual([
      { input: "partial-input", claimed: [] }, { input: "partial-input", claimed: [] },
    ])
    expect(observed.events.filter((event) => event.kind === "inbox.queued")).toHaveLength(1)
    expect(observed.events.filter((event) => event.kind === "inbox.dropped")).toHaveLength(0)
  })
})
