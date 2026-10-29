import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Tool } from "effect/ai"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  onTool,
  SessionLogMemoryLive,
  Sessions,
  subscribeAll,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { SessionLogEvent, Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A journey, key-free, with scripted models: a user's turn is cancelled while
 * a tool call is in flight, and a new turn resumes it. Each action runs in
 * order against one fresh session and records what the host observed.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  failure: Failure,
  failureMode: "return",
})
const FetchPage = Tool.make("fetch_page", {
  description: "Fetch a record's page.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ page: Schema.String }),
  failure: Failure,
  failureMode: "return",
})
const Deliver = Tool.make("deliver", {
  description: "Deliver the final answer.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})

/** The host's tools: `fetch_page` hangs while `slow` is set, after saying it started. */
const toolsOf = (slow: Ref.Ref<boolean>, fetching: Deferred.Deferred<void>, fetched: Ref.Ref<number>) => defineCapability({
  id: "journey-host", version: "1",
  tools: [
    defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed({ ids: [`record-${query}-a`] }), view: { version: "1", render: (result) => `FOUND ${result.ids.join(", ")}` } }),
    defineTool({
      tool: FetchPage,
      handler: ({ id }) => Ref.update(fetched, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(slow)),
        Effect.flatMap((hangs) => hangs ? Deferred.succeed(fetching, undefined).pipe(Effect.andThen(Effect.never)) : Effect.succeed({ page: `PAGE of ${id}` })),
      ),
    }),
    defineTool({ tool: Deliver, handler: () => Effect.succeed(true) }),
  ],
  skills: [defineSkill({ id: "records", summary: "Find records and deliver their pages.", tools: ["lookup", "fetch_page", "deliver"], always: true })],
})

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]

/** A scripted provider: its answers in order, and the prompt of every request it was sent. */
const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(prompts, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]]).pipe(
      Effect.map((index) => (script[index] ?? [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage }]) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { prompts, model }
})

/** Run until the answer is delivered: the reply is what was delivered. */
const deliverAnswer = (turn: Turn) => Effect.gen(function* () {
  const delivered = yield* Ref.make(Option.none<string>())
  yield* subscribeAll(turn.events, [onTool(Deliver, ({ input }) => Ref.set(delivered, Option.some(input.text)))])
  yield* turn.tools.select(turn.userMessage)
  const result = yield* turn.run({
    completion: () => Ref.get(delivered).pipe(Effect.map((text) => ({ complete: Option.isSome(text), awaiting: [], facts: {} }))),
    limits: { requireCompletion: true },
  })
  return { outcome: result.outcome, reply: yield* Ref.get(delivered) } satisfies TurnOutcome
})

const turnOf = (event: SessionLogEvent) => Option.getOrNull(event.turn)
const ofTurn = (events: ReadonlyArray<SessionLogEvent>, turn: number) => events.filter((event) => turnOf(event) === turn)

const session = { id: ConversationId.make("00000000-0000-4000-8000-0000000000aa"), owner: "journey" }
const message = new UserMessage({ text: "find alpha and fetch its page" })

/** Steps 1 and 2 of both journeys: ask, then cancel turn 1 while its fetch_page call runs; later fetch_page calls return at once. */
const cancelledMidToolCall = Effect.gen(function* () {
  const slow = yield* Ref.make(true)
  const fetching = yield* Deferred.make<void>()
  const fetched = yield* Ref.make(0)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [toolsOf(slow, fetching, fetched)],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 6 },
  })
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: session.owner, id: session.id })
  const services = (model: LanguageModel.LanguageModel) => Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions))

  // 1. ask: the model looks alpha up (a whole step), then calls fetch_page, which hangs.
  const first = yield* scripted([call("c1", "lookup", { query: "alpha" }), call("c2", "fetch_page", { id: "record-alpha-a" })])
  const asking = yield* Effect.forkChild(agent.turn({ turn: { session, userMessage: message, runId: "run-1" }, services: services(first.model) }, deliverAnswer))
  yield* Deferred.await(fetching)

  // 2. cancel while fetch_page runs: the turn fails with turn.closed.
  const cancelled = yield* sessions.cancel(session, 1)
  const asked = yield* Fiber.await(asking)
  const afterCancel = yield* sessions.read(session)
  yield* Ref.set(slow, false)
  return { agent, sessions, services, fetched, cancelled, asked, afterCancel }
})

/** A provider that is down: every request fails. */
const down = LanguageModel.make({
  generateText: () => Effect.fail(AiError.make({ module: "Journey", method: "generateText", reason: new AiError.UnknownError({ description: "the provider was down" }) })),
  streamText: () => Stream.die("not scripted") as never,
})

describe("journey: resume a turn cancelled mid-tool-call", () => {
  test("ask, cancel while a tool runs, resume with the same message, retry the resume, resume a finished turn", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { agent, sessions, services, fetched, cancelled, asked, afterCancel } = yield* cancelledMidToolCall

      // 3. resume turn 1 with the same message: memory keeps turn 1's whole steps.
      const second = yield* scripted([call("c3", "fetch_page", { id: "record-alpha-a" }), call("c4", "deliver", { text: "PAGE of record-alpha-a" })])
      const resumed = yield* agent.turn({ turn: { session, userMessage: message, runId: "run-2", resumes: 1 }, services: services(second.model) }, (turn) =>
        deliverAnswer(turn).pipe(Effect.map((outcome) => ({ ...outcome, reply: Option.map(outcome.reply, (text) => `${text} (turn ${turn.turn} resumes ${turn.admitted.resumes ?? "nothing"})`) }))))

      // 4. retry the resume (a client retrying the request): the turn already begun is the answer.
      const retried = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: "run-3", resumes: 1 }, services: services(second.model) }, deliverAnswer))

      // 5. resume the finished turn 2: refused, nothing opened.
      const refused = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: "run-4", resumes: 2 }, services: services(second.model) }, deliverAnswer))

      return {
        cancelled, asked, afterCancel, resumed, retried, refused,
        resumedPrompt: (yield* Ref.get(second.prompts))[0] ?? "",
        fetched: yield* Ref.get(fetched),
        all: yield* sessions.read(session),
        view: yield* sessions.get(session),
      }
    })))

    // 1-2. The cancel closed turn 1 while fetch_page ran; the turn failed with turn.closed.
    expect(observed.cancelled.cancelled).toBe(true)
    expect(Option.map(Exit.findErrorOption(observed.asked), (error) => error.code)).toEqual(Option.some("turn.closed"))
    // What is durable after the cancel: the turn's start, its whole first step, the turn's end as cancelled,
    // and no reply. Of the step in flight, only events its writer stored before the cancel remain (here at most
    // fetch_page's tool.started, depending on whether its commit won the race): never its call or result in memory.
    const turnOne = ofTurn(observed.afterCancel, 1)
    expect(turnOne.filter((event) => event.kind === "memory.tool-result").map((event) => (event.data.body as { readonly toolName: string }).toolName)).toEqual(["lookup"])
    expect(turnOne.filter((event) => event.kind === "tool.started").map((event) => event.data.tool).filter((tool) => tool !== "fetch_page")).toEqual(["lookup"])
    expect(turnOne.filter((event) => event.kind === "tool.completed").map((event) => event.data.tool)).toEqual(["lookup"])
    expect(turnOne.some((event) => event.kind === "turn.reply")).toBe(false)
    expect(turnOne.filter((event) => event.kind === "turn.ended").map((event) => [event.data.reason, event.data.failure ?? null])).toEqual([["cancelled", null]])
    expect(turnOne.at(-1)?.kind).toBe("turn.ended")

    // 3. The resuming turn sees turn 1's message and whole step, not the call that was in flight, then the message again.
    expect(observed.resumed.outcome).toBe("completed")
    expect(Option.getOrNull(observed.resumed.reply)).toBe("PAGE of record-alpha-a (turn 2 resumes 1)")
    const prompt = observed.resumedPrompt
    const firstAsk = prompt.indexOf("find alpha and fetch its page")
    expect(firstAsk).toBeGreaterThan(-1)
    expect(prompt.indexOf("FOUND record-alpha-a")).toBeGreaterThan(firstAsk)
    expect(prompt.indexOf("find alpha and fetch its page", firstAsk + 1)).toBeGreaterThan(prompt.indexOf("FOUND record-alpha-a"))
    expect(prompt).not.toContain("\"c2\"")
    // The tool already run is not undone: fetch_page ran once in the cancelled turn and once in the resumed one.
    expect(observed.fetched).toBe(2)
    const turnTwo = ofTurn(observed.all, 2)
    expect(turnTwo[0]?.data).toMatchObject({ key: "resume:1", resumes: 1, runId: "run-2", origin: "user" })
    expect(turnTwo.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["completed"])

    // 4-5. A retried resume is the turn it began; a finished turn cannot be resumed; neither opened a turn.
    expect(observed.retried.code).toBe("turn.duplicate")
    expect([observed.refused.code, observed.refused.message]).toEqual(["turn.not-resumable", "turn 2 of session 00000000-0000-4000-8000-0000000000aa cannot be resumed (finished)"])
    expect([observed.view.turns, Option.isNone(observed.view.open)]).toEqual([2, true])
  })

  test("ask, cancel while a tool runs, resume while the provider is down, retry with the default key, try again with a new key", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { agent, sessions, services } = yield* cancelledMidToolCall

      // 3. resume turn 1 while the provider is down: the resuming turn fails.
      const failed = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: "run-2", resumes: 1 }, services: services(yield* down) }, deliverAnswer))

      // 4. retry with the default key: that failed turn is the answer.
      const again = yield* scripted([call("c3", "fetch_page", { id: "record-alpha-a" }), call("c4", "deliver", { text: "PAGE of record-alpha-a" })])
      const duplicate = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: "run-3", resumes: 1 }, services: services(again.model) }, deliverAnswer))

      // 5. try the resume again with a new key: the failed resume does not stand in the way.
      const retried = yield* agent.turn({ turn: { session, userMessage: message, runId: "run-4", key: "resume:1:2", resumes: 1 }, services: services(again.model) }, deliverAnswer)

      // 6. once a resume completed, turn 1 is answered: a further resume is refused.
      const answered = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: "run-5", key: "resume:1:3", resumes: 1 }, services: services(again.model) }, deliverAnswer))

      return { failed, duplicate, retried, answered, prompt: (yield* Ref.get(again.prompts))[0] ?? "", all: yield* sessions.read(session) }
    })))

    expect(observed.all.filter((event) => event.kind === "turn.ended").map((event) => [turnOf(event), event.data.reason])).toEqual([[1, "cancelled"], [2, "failed"], [3, "completed"]])
    expect(observed.failed.code).toBe("loop.failed")
    expect(observed.duplicate.code).toBe("turn.duplicate")
    expect([observed.retried.outcome, Option.getOrNull(observed.retried.reply)]).toEqual(["completed", "PAGE of record-alpha-a"])
    expect(ofTurn(observed.all, 3)[0]?.data).toMatchObject({ key: "resume:1:2", resumes: 1, runId: "run-4", origin: "user" })
    // The retry sees what a plain new turn would: turn 1's message and whole step, then the messages after it.
    const prompt = observed.prompt
    expect(prompt.indexOf("FOUND record-alpha-a")).toBeGreaterThan(prompt.indexOf("find alpha and fetch its page"))
    expect(prompt.lastIndexOf("find alpha and fetch its page")).toBeGreaterThan(prompt.indexOf("FOUND record-alpha-a"))
    expect([observed.answered.code, observed.answered.message]).toEqual(["turn.not-resumable", "turn 1 of session 00000000-0000-4000-8000-0000000000aa cannot be resumed (superseded)"])
  })
})
