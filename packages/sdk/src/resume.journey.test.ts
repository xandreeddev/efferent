import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Tool } from "effect/ai"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema, SchemaGetter, Stream } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  harnessCodeOf,
  onTool,
  RunId,
  SessionLog,
  SessionLogMemoryLive,
  Sessions,
  subscribeAll,
  toolCallStatesOf,
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

/** A failure by its framework code (`harnessCodeOf`), else its tag. */
const codeOf = (error: { readonly _tag: string }): string => Option.getOrElse(harnessCodeOf(error), () => error._tag)

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
  const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: session.owner, id: session.id })
  const services = (model: LanguageModel.LanguageModel) => Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions))

  // 1. ask: the model looks alpha up (a whole step), then calls fetch_page, which hangs.
  const first = yield* scripted([call("c1", "lookup", { query: "alpha" }), call("c2", "fetch_page", { id: "record-alpha-a" })])
  const asking = yield* Effect.forkChild(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-1") }, services: services(first.model) }, deliverAnswer))
  yield* Deferred.await(fetching)

  // 2. cancel while fetch_page runs: the turn fails with TurnClosed (turn.closed).
  const cancelled = yield* sessions.cancel(session, 1)
  const asked = yield* Fiber.await(asking)
  const afterCancel = yield* sessions.read(session)
  yield* Ref.set(slow, false)
  return { agent, sessions, services, fetched, cancelled, asked, afterCancel, states: yield* toolCallStatesOf(afterCancel) }
})

/** A provider that is down: every request fails. */
const down = LanguageModel.make({
  generateText: () => Effect.fail(AiError.make({ module: "Journey", method: "generateText", reason: new AiError.UnknownError({ description: "the provider was down" }) })),
  streamText: () => Stream.die("not scripted") as never,
})

describe("journey: resume a turn cancelled mid-tool-call", () => {
  test("ask, cancel while a tool runs, resume with the same message, retry the resume, resume a finished turn", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { agent, sessions, services, fetched, cancelled, asked, afterCancel, states } = yield* cancelledMidToolCall

      // 3. resume turn 1 with the same message: memory keeps turn 1's whole steps.
      const second = yield* scripted([call("c3", "fetch_page", { id: "record-alpha-a" }), call("c4", "deliver", { text: "PAGE of record-alpha-a" })])
      const resumed = yield* agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-2"), resumes: 1 }, services: services(second.model) }, (turn) =>
        deliverAnswer(turn).pipe(Effect.map((outcome) => ({ ...outcome, reply: Option.map(outcome.reply, (text) => `${text} (turn ${turn.turn} resumes ${turn.admitted.resumes ?? "nothing"})`) }))))

      // 4. retry the resume (a client retrying the request): the turn already begun is the answer.
      const retried = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-3"), resumes: 1 }, services: services(second.model) }, deliverAnswer))

      // 5. resume the finished turn 2: refused, nothing opened.
      const refused = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-4"), resumes: 2 }, services: services(second.model) }, deliverAnswer))

      return {
        cancelled, asked, afterCancel, states, resumed, retried, refused,
        resumedPrompt: (yield* Ref.get(second.prompts))[0] ?? "",
        fetched: yield* Ref.get(fetched),
        all: yield* sessions.read(session),
        view: yield* sessions.get(session),
      }
    })))

    // 1-2. The cancel closed turn 1 while fetch_page ran; the turn failed with that TurnClosed, whose code is turn.closed.
    expect(observed.cancelled.cancelled).toBe(true)
    expect(Option.map(Exit.findErrorOption(observed.asked), (error) => [error._tag, error._tag === "TurnClosed" ? error.reason : null, codeOf(error)]))
      .toEqual(Option.some(["TurnClosed", "cancelled", "turn.closed"]))
    // The in-flight call and its start were flushed before the handler ran. It has no recorded result.
    const turnOne = ofTurn(observed.afterCancel, 1)
    expect(turnOne.filter((event) => event.kind === "memory.tool-result").map((event) => (event.data.body as { readonly toolName: string }).toolName)).toEqual(["lookup"])
    expect(turnOne.filter((event) => event.kind === "tool.started").map((event) => event.data.tool)).toEqual(["lookup", "fetch_page"])
    expect(observed.states.map((state) => [String(state.toolCallId), state._tag])).toEqual([["c1", "Completed"], ["c2", "Started"]])
    expect(turnOne.filter((event) => event.kind === "step.usage")).toHaveLength(2)
    expect(turnOne.filter((event) => event.kind === "tool.completed").map((event) => event.data.tool)).toEqual(["lookup"])
    expect(turnOne.some((event) => event.kind === "turn.reply")).toBe(false)
    expect(turnOne.filter((event) => event.kind === "turn.ended").map((event) => [event.data.reason, event.data.failure ?? null])).toEqual([["cancelled", null]])
    expect(turnOne.at(-1)?.kind).toBe("turn.ended")

    // 3. The resumed model sees the unfinished call answered as interrupted, then the new user's message.
    expect(observed.resumed.outcome).toBe("completed")
    expect(Option.getOrNull(observed.resumed.reply)).toBe("PAGE of record-alpha-a (turn 2 resumes 1)")
    const prompt = observed.resumedPrompt
    const firstAsk = prompt.indexOf("find alpha and fetch its page")
    expect(firstAsk).toBeGreaterThan(-1)
    expect(prompt.indexOf("FOUND record-alpha-a")).toBeGreaterThan(firstAsk)
    expect(prompt.indexOf("find alpha and fetch its page", firstAsk + 1)).toBeGreaterThan(prompt.indexOf("FOUND record-alpha-a"))
    expect(prompt).toContain("\"c2\"")
    expect(prompt).toContain("ToolInterrupted")
    // The tool already run is not undone: fetch_page ran once in the cancelled turn and once in the resumed one.
    expect(observed.fetched).toBe(2)
    const turnTwo = ofTurn(observed.all, 2)
    expect(turnTwo[0]?.data).toMatchObject({ key: "resume:1", resumes: 1, runId: "run-2", origin: "user" })
    expect(turnTwo.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["completed"])

    // 4-5. A retried resume is the turn it began; a finished turn cannot be resumed; neither opened a turn.
    // Each refusal reaches the caller as it is, naming the turn, and stands for its code.
    expect([codeOf(observed.retried), observed.retried]).toMatchObject(["turn.duplicate", { _tag: "TurnDuplicate", turn: 2, open: false }])
    expect([codeOf(observed.refused), observed.refused]).toMatchObject(["turn.not-resumable", { _tag: "NotResumable", session: "00000000-0000-4000-8000-0000000000aa", turn: 2, reason: "finished" }])
    expect([observed.view.turns, Option.isNone(observed.view.open)]).toEqual([2, true])
  })

  test("ask, cancel while a tool runs, resume while the provider is down, retry with the default key, try again with a new key", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { agent, sessions, services } = yield* cancelledMidToolCall

      // 3. resume turn 1 while the provider is down: the resuming turn fails.
      const failed = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-2"), resumes: 1 }, services: services(yield* down) }, deliverAnswer))

      // 4. retry with the default key: that failed turn is the answer.
      const again = yield* scripted([call("c3", "fetch_page", { id: "record-alpha-a" }), call("c4", "deliver", { text: "PAGE of record-alpha-a" })])
      const duplicate = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-3"), resumes: 1 }, services: services(again.model) }, deliverAnswer))

      // 5. try the resume again with a new key: the failed resume does not stand in the way.
      const retried = yield* agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-4"), key: "resume:1:2", resumes: 1 }, services: services(again.model) }, deliverAnswer)

      // 6. once a resume completed, turn 1 is answered: a further resume is refused.
      const answered = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-5"), key: "resume:1:3", resumes: 1 }, services: services(again.model) }, deliverAnswer))

      return { failed, duplicate, retried, answered, prompt: (yield* Ref.get(again.prompts))[0] ?? "", all: yield* sessions.read(session) }
    })))

    expect(observed.all.filter((event) => event.kind === "turn.ended").map((event) => [turnOf(event), event.data.reason])).toEqual([[1, "cancelled"], [2, "failed"], [3, "completed"]])
    expect(codeOf(observed.failed)).toBe("model.failed")
    expect(codeOf(observed.duplicate)).toBe("turn.duplicate")
    expect([observed.retried.outcome, Option.getOrNull(observed.retried.reply)]).toEqual(["completed", "PAGE of record-alpha-a"])
    expect(ofTurn(observed.all, 3)[0]?.data).toMatchObject({ key: "resume:1:2", resumes: 1, runId: "run-4", origin: "user" })
    // The retry sees what a plain new turn would: turn 1's message and whole step, then the messages after it.
    const prompt = observed.prompt
    expect(prompt.indexOf("FOUND record-alpha-a")).toBeGreaterThan(prompt.indexOf("find alpha and fetch its page"))
    expect(prompt.lastIndexOf("find alpha and fetch its page")).toBeGreaterThan(prompt.indexOf("FOUND record-alpha-a"))
    expect([codeOf(observed.answered), observed.answered]).toMatchObject(["turn.not-resumable", { _tag: "NotResumable", session: "00000000-0000-4000-8000-0000000000aa", turn: 1, reason: "superseded" }])
  })
})

describe("journey: a new process takes over a turn its stopped holder left open", () => {
  test("a turn held by an instance that stopped, its tool still running, is taken over and resumed at once by another instance", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const slow = yield* Ref.make(true)
      const fetching = yield* Deferred.make<void>()
      const fetched = yield* Ref.make(0)
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
        capabilities: [toolsOf(slow, fetching, fetched)],
        turnServices: [LanguageModel.LanguageModel],
        limits: { streaming: false, maxSteps: 6 },
      })
      // Two instances over one log, as two processes over one store, each holding its turns for a long lease.
      const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
      const instance = () => Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 600_000, renew: "on-commit" } }).pipe(
        Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))).pipe(Effect.map(Context.get(Sessions)))
      const [stopped, successor] = [yield* instance(), yield* instance()]
      yield* stopped.create({ owner: session.owner, id: session.id })
      const services = (sessions: Context.Service.Shape<typeof Sessions>, model: LanguageModel.LanguageModel) => Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions))

      // 1. The first process asks: a whole step (lookup), then fetch_page, which hangs: the process stops answering here.
      const first = yield* scripted([call("c1", "lookup", { query: "alpha" }), call("c2", "fetch_page", { id: "record-alpha-a" })])
      const asking = yield* Effect.forkChild(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-1") }, services: services(stopped, first.model) }, deliverAnswer))
      yield* Deferred.await(fetching)
      yield* Ref.set(slow, false)

      // 2. Without takeOver, the new process waits for the lease: SessionBusy.
      const second = yield* scripted([call("c3", "fetch_page", { id: "record-alpha-a" }), call("c4", "deliver", { text: "PAGE of record-alpha-a" })])
      const busy = yield* Effect.flip(agent.turn({ turn: { session, userMessage: message, runId: RunId.make("run-2"), resumes: 1 }, services: services(successor, second.model) }, deliverAnswer))

      // 3. With takeOver, it closes turn 1 and resumes it at once, in one begin.
      const resumed = yield* agent.turn({ turn: { session, userMessage: new UserMessage({ text: "Continue." }), runId: RunId.make("run-3"), resumes: 1, takeOver: true }, services: services(successor, second.model) }, deliverAnswer)

      // 4. The stopped process's turn, when its tool returns, writes nothing more: its writer was fenced.
      yield* Fiber.interrupt(asking)
      return { busy, resumed, resumedPrompt: (yield* Ref.get(second.prompts))[0] ?? "", all: yield* successor.read(session) }
    })))

    expect(codeOf(observed.busy)).toBe("session.busy")
    expect(observed.resumed.outcome).toBe("completed")
    // The resuming turn's model sees turn 1's message and its whole step, then "Continue.".
    const prompt = observed.resumedPrompt
    expect(prompt.indexOf("FOUND record-alpha-a")).toBeGreaterThan(prompt.indexOf("find alpha and fetch its page"))
    expect(prompt.indexOf("Continue.")).toBeGreaterThan(prompt.indexOf("FOUND record-alpha-a"))
    const endings = observed.all.filter((event) => event.kind === "turn.ended").map((event) => [turnOf(event), event.data.reason, (event.data.failure as { readonly code: string } | null)?.code ?? null])
    expect(endings).toEqual([[1, "interrupted", "turn.takeover"], [2, "completed", null]])
    expect(ofTurn(observed.all, 2)[0]?.data).toMatchObject({ key: "resume:1", resumes: 1, runId: "run-3" })
    // Nothing of turn 1 was stored after its takeover.
    const takeover = observed.all.findIndex((event) => event.kind === "turn.ended")
    expect(observed.all.slice(takeover + 1).filter((event) => turnOf(event) === 1)).toEqual([])
  })
})

test("a view that dies after a handler returned keeps its raw result and the failed step's result identity", async () => {
  const Rendered = Tool.make("rendered", {
    parameters: Schema.Struct({}),
    success: Schema.Number.pipe(Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.transformEffect(() => Effect.die(new Error("the host view's decoder failed"))),
      encode: SchemaGetter.transform((number: number) => number),
    })),
    failure: Failure, failureMode: "return",
  })
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const address = { owner: "durable-view", id: ConversationId.make("00000000-0000-4000-8000-00000000f111") }
    yield* sessions.create(address)
    const agent = yield* Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
      capabilities: [defineCapability({ id: "view-host", version: "1", tools: [defineTool({
        tool: Rendered, handler: () => Effect.succeed(9), view: { version: "1", render: (number) => `N ${number}` },
      })], skills: [defineSkill({ id: "rendered", summary: "Read a number.", tools: [Rendered.name], always: true })] })],
      turnServices: [LanguageModel.LanguageModel], limits: { streaming: false },
    })
    const model = yield* scripted([call("c1", Rendered.name, {})])
    const outcome = yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: "read it" }), runId: RunId.make("view-run") },
      services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, model.model)),
    }, (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })))).pipe(Effect.exit)
    const stored = yield* sessions.read(address)
    return { outcome, stored, states: yield* toolCallStatesOf(stored) }
  })))
  expect(observed.outcome._tag).toBe("Failure")
  const result = observed.stored.find((event) => event.kind === "memory.tool-result")
  expect(result?.data.body).toMatchObject({ toolCallId: "c1", encoded: 9, view: "9", viewVersion: "raw" })
  const ended = observed.stored.find((event) => event.kind === "step.ended")
  expect(ended?.data.status).toBe("failed")
  expect(ended?.data.results).toEqual([{ entry: result?.data.entry ?? "missing", toolCallId: "c1", tool: Rendered.name, ok: true }])
  expect(observed.states).toMatchObject([{ _tag: "Completed", result: { encoded: 9, isError: false } }])
  expect(observed.stored.some((event) => event.kind === "memory.tool-presentation")).toBe(false)
})
