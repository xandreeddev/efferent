import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import { Context, Effect, Exit, Layer, Logger, Metric, Option, Ref, References, Schema, Stream, Tracer } from "effect"
import {
  ConversationId,
  CurrentTraceContent,
  defineCapability,
  definePlugin,
  defineSkill,
  defineTool,
  Failure,
  HarnessError,
  SessionLogMemoryLive,
  Sessions,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { JsonObject, SessionLogEvent, Turn, TurnError, TurnOutcome, TurnPolicy } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/* ── a host whose lookup handler opens a span of its own, and whose archive runs once per turn ── */

const Lookup = Tool.make("lookup", {
  description: "Look a record up.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Archive = Tool.make("archive", {
  description: "Archive a record.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const host = defineCapability({
  id: "trace-host", version: "1",
  tools: [
    defineTool({ tool: Lookup, handler: ({ query }) => Effect.logDebug("looking a record up").pipe(Effect.as(`found ${query}`), Effect.withSpan("lookup.query")) }),
    defineTool({ tool: Archive, handler: ({ id }) => Effect.succeed(`archived ${id}`), annotations: { maxCallsPerRun: Option.some(1) } }),
  ],
  skills: [defineSkill({ id: "records", summary: "Look records up and archive them.", tools: [Lookup.name, Archive.name], always: true })],
})

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
/** Look up, then archive twice in one response (the second is refused), then answer. */
const script: ReadonlyArray<Part> = [
  [{ type: "tool-call", id: "c1", name: Lookup.name, params: { query: "alpha" } }, { type: "finish", reason: "tool-calls", usage }],
  [
    { type: "tool-call", id: "c2", name: Archive.name, params: { id: "record-alpha" } },
    { type: "tool-call", id: "c3", name: Archive.name, params: { id: "record-alpha-again" } },
    { type: "finish", reason: "tool-calls", usage },
  ],
  [{ type: "text", text: "archived record-alpha" }, { type: "finish", reason: "stop", usage }],
]

/** The scripted model, recording the trace content switch each call reads. */
const scripted = (reads: Ref.Ref<ReadonlyArray<boolean>>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: () => Effect.service(CurrentTraceContent).pipe(
      Effect.flatMap((capture) => Ref.update(reads, (all) => [...all, capture])),
      Effect.andThen(Ref.getAndUpdate(served, (index) => index + 1)),
      Effect.map((index) => (script[index] ?? script[2]) as never),
    ),
    streamText: () => Stream.die("not scripted") as never,
  })
})

/** A tracer keeping every span it starts. */
const capturingTracer = (spans: Array<Tracer.NativeSpan>) => Tracer.make({
  span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})

const conversation = ConversationId.make("00000000-0000-4000-8000-0000000000d7")

/** Activate the always-on skill, then run the turn to its end, the run wrapped in the host's own span. */
const runToEnd = (policy: TurnPolicy = {}) => (turn: Turn): Effect.Effect<TurnOutcome, TurnError> =>
  turn.tools.select(turn.userMessage).pipe(
    Effect.andThen(turn.run(policy).pipe(Effect.withSpan("host.use"))),
    Effect.map((run): TurnOutcome => ({ outcome: run.outcome, reply: Option.some(run.text) })),
  )

interface Traced {
  readonly exit: Exit.Exit<unknown, unknown>
  readonly spans: ReadonlyArray<Tracer.NativeSpan>
  readonly stored: ReadonlyArray<SessionLogEvent>
  /** `CurrentTraceContent` as each model call read it. */
  readonly reads: ReadonlyArray<boolean>
}

/** One turn of a fresh agent, under the host's `host.request` span, with a tracer that keeps every span. */
const traced = (options: {
  readonly config?: Partial<AgentConfig>
  readonly use?: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError>
  readonly meta?: JsonObject
  readonly createSession?: boolean
  /** The turn's services as the host hands them over (by default, as they are). */
  readonly services?: (services: Context.Context<never>) => Effect.Effect<Context.Context<never>>
  /** Around the `Agent.turn` call, under `host.request`. */
  readonly around?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
} = {}): Effect.Effect<Traced> => Effect.scoped(Effect.gen(function* () {
  const spans: Array<Tracer.NativeSpan> = []
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 6 },
    ...options.config,
  })
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: conversation, owner: "test" }
  if (options.createSession !== false) yield* sessions.create({ owner: address.owner, id: conversation })
  const reads = yield* Ref.make<ReadonlyArray<boolean>>([])
  const model = yield* scripted(reads)
  const exit = yield* Effect.gen(function* () {
    const services = yield* (options.services ?? Effect.succeed)(Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)))
    return yield* (options.around ?? ((effect) => effect))(agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: "archive alpha" }), runId: "run-1", ...(options.meta === undefined ? {} : { meta: options.meta }) },
      services,
    }, options.use ?? runToEnd()))
  }).pipe(Effect.withSpan("host.request"), Effect.withTracer(capturingTracer(spans)), Effect.exit)
  const stored = options.createSession === false ? [] : yield* sessions.read(address)
  return { exit, spans, stored, reads: yield* Ref.get(reads) }
}).pipe(Effect.orDie))

/** The turn's services with a Sessions whose begin opens a span of its own and logs, as a store's would. */
const beginTraced = (services: Context.Context<never>): Effect.Effect<Context.Context<never>> => Effect.sync(() => Context.getUnsafe(services, Sessions)).pipe(
  Effect.map((sessions) => Context.add(services, Sessions, {
    ...sessions,
    begin: (address, input) => Effect.logDebug("beginning a turn").pipe(Effect.andThen(sessions.begin(address, input)), Effect.withSpan("store.begin")),
  })),
)

/** A session-scoped plugin whose activation opens a span. */
const activated = definePlugin({
  id: "trace-session-plugin", version: "1", scope: "session",
  config: Schema.Struct({}), defaults: {}, provides: [],
  layer: () => Layer.effectDiscard(Effect.void.pipe(Effect.withSpan("plugin.activate"))),
})

/** A logger keeping each line's message and annotations (the lines above are debug lines). */
const capturingLogger = (lines: Array<{ readonly message: string; readonly annotations: Readonly<Record<string, unknown>> }>) => Logger.layer([Logger.make((options) => {
  lines.push({ message: [options.message].flat().join(" "), annotations: options.fiber.getRef(References.CurrentLogAnnotations) })
})])

const named = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) => spans.filter((span) => span.name === name)
const one = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string): Tracer.NativeSpan => {
  const found = named(spans, name)
  expect(found.map((span) => span.name)).toEqual([name])
  return found[0]!
}

/** A span's ancestors, nearest first, among the spans the tracer kept. */
const ancestors = (spans: ReadonlyArray<Tracer.NativeSpan>, span: Tracer.NativeSpan): ReadonlyArray<Tracer.NativeSpan> => {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate] as const))
  const up = (current: Tracer.NativeSpan, seen: ReadonlyArray<Tracer.NativeSpan>): ReadonlyArray<Tracer.NativeSpan> => Option.match(
    Option.flatMap(current.parent, (parent) => Option.fromNullishOr(byId.get(parent.spanId))),
    { onNone: () => seen, onSome: (parent) => up(parent, [...seen, parent]) },
  )
  return up(span, [])
}
const parentName = (spans: ReadonlyArray<Tracer.NativeSpan>, span: Tracer.NativeSpan) => ancestors(spans, span)[0]?.name

const read = (span: Tracer.NativeSpan | undefined, keys: ReadonlyArray<string>) => keys.map((key) => span?.attributes.get(key))
const ids = ["efferent.session.id", "efferent.run.id", "efferent.turn"]

describe("a turn's trace", () => {
  test("agent.turn is the root of the turn, under the caller's span, and every span under it carries the turn's ids", async () => {
    const { exit, spans } = await Effect.runPromise(traced())
    expect(Exit.isSuccess(exit)).toBe(true)
    const turn = one(spans, "agent.turn")
    expect(parentName(spans, turn)).toBe("host.request")
    // The begin is the turn's sibling: its subtree is not the turn's.
    const begin = one(spans, "agent.turn.begin")
    const inTurn = spans.filter((span) => span !== turn && span.name !== "host.request" && span !== begin && !ancestors(spans, span).includes(begin))
    expect(inTurn.length).toBeGreaterThan(5)
    expect(inTurn.filter((span) => !ancestors(spans, span).includes(turn)).map((span) => span.name)).toEqual([])
    expect(inTurn.filter((span) => JSON.stringify(read(span, ids)) !== JSON.stringify([conversation, "run-1", 1])).map((span) => span.name)).toEqual([])
    // The caller's span is not the turn's: it carries no turn ids.
    expect(read(one(spans, "host.request"), ids)).toEqual([undefined, undefined, undefined])
  })

  test("spans nest where their work runs: the run under the host's span in use, tool calls under the model call, handler spans under their tool", async () => {
    const { spans } = await Effect.runPromise(traced())
    expect(parentName(spans, one(spans, "engine.run"))).toBe("host.use")
    const toolSpans = spans.filter((span) => span.name.startsWith("tool."))
    expect(toolSpans.map((span) => span.name).sort()).toEqual(["tool.archive", "tool.archive", "tool.lookup"])
    expect(toolSpans.filter((span) => !ancestors(spans, span).some((above) => above.name === "engine.turn" || above.name.startsWith("LanguageModel."))).map((span) => span.name)).toEqual([])
    expect(toolSpans.map((span) => parentName(spans, span))).toEqual(toolSpans.map(() => expect.stringMatching(/^(engine\.turn|LanguageModel\.)/)))
    expect(parentName(spans, one(spans, "lookup.query"))).toBe("tool.lookup")
    expect(named(spans, "engine.turn").every((span) => parentName(spans, span) === "engine.run")).toBe(true)
  })

  test("agent.turn starts with the conversation, origin and allowed metadata, and ends with the outcome and usage", async () => {
    const { exit, spans } = await Effect.runPromise(traced({
      config: { spanMeta: ["requestId", "plan"] },
      meta: { requestId: "req-9", user: "u-1", plan: { tier: "pro" } },
    }))
    const turn = one(spans, "agent.turn")
    expect(read(turn, [...ids, "gen_ai.conversation.id", "efferent.origin", "efferent.meta.requestId", "efferent.meta.plan"]))
      .toEqual([conversation, "run-1", 1, conversation, "user", "req-9", "{\"tier\":\"pro\"}"])
    expect(turn.attributes.has("efferent.meta.user")).toBe(false)
    const result = Exit.isSuccess(exit) ? exit.value as { readonly usage: { readonly inputTokens: number; readonly outputTokens: number } } : undefined
    expect(read(turn, ["efferent.outcome", "efferent.usage.input_tokens", "efferent.usage.output_tokens", "efferent.usage.total_tokens"]))
      .toEqual(["completed", 300, 30, 330])
    expect(result?.usage.inputTokens).toBe(300)
    expect(turn.attributes.has("efferent.failure.code")).toBe(false)
  })

  test("host annotations, and turn services captured under them and under a host span, neither replace the turn's ids nor re-parent its spans", async () => {
    const { exit, spans } = await Effect.runPromise(traced({
      // The host's services captured inside its own annotated region, under its own span.
      services: (services) => Effect.context<never>().pipe(
        Effect.map((captured) => Context.merge(captured, services)),
        Effect.annotateSpans({ "host.tenant": "t-1" }),
        Effect.withSpan("host.capture"),
      ),
      around: (effect) => effect.pipe(Effect.annotateSpans({ "host.tenant": "t-1" })),
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    const turn = one(spans, "agent.turn")
    expect(parentName(spans, turn)).toBe("host.request")
    const inTurn = spans.filter((span) => ancestors(spans, span).includes(turn))
    expect(inTurn.length).toBeGreaterThan(5)
    expect(inTurn.filter((span) => JSON.stringify(read(span, [...ids, "host.tenant"])) !== JSON.stringify([conversation, "run-1", 1, "t-1"])).map((span) => span.name)).toEqual([])
    expect(spans.filter((span) => parentName(spans, span) === "host.capture").map((span) => span.name)).toEqual([])
  })

  test("agent.turn.begin is the turn's sibling under the caller's span, encloses the session plugins' activation and Sessions.begin, and names the turn", async () => {
    const { exit, spans } = await Effect.runPromise(traced({
      config: { plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, activated] },
      services: beginTraced,
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    const begin = one(spans, "agent.turn.begin")
    expect([parentName(spans, begin), parentName(spans, one(spans, "agent.turn"))]).toEqual(["host.request", "host.request"])
    expect([parentName(spans, one(spans, "plugin.activate")), parentName(spans, one(spans, "store.begin"))]).toEqual(["agent.turn.begin", "agent.turn.begin"])
    expect(read(begin, [...ids, "efferent.origin"])).toEqual([conversation, "run-1", 1, "user"])
    expect(begin.attributes.has("efferent.failure.code")).toBe(false)
  })

  test("a turn the host began has no begin span", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false } })
      const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
      const address = { id: conversation, owner: "test" }
      yield* sessions.create({ owner: address.owner, id: conversation })
      const model = yield* scripted(yield* Ref.make<ReadonlyArray<boolean>>([]))
      return yield* Effect.gen(function* () {
        const writer = yield* sessions.begin(address, { _tag: "User", userMessage: new UserMessage({ text: "hi" }), runId: "run-1", key: "run-1", command: {}, meta: {} })
        return yield* agent.turn({ turn: writer, services: Context.make(LanguageModel.LanguageModel, model) }, (turn) => turn.reply("hello"))
      }).pipe(Effect.withSpan("host.request"), Effect.withTracer(capturingTracer(spans)), Effect.exit)
    })).pipe(Effect.orDie))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(parentName(spans, one(spans, "agent.turn"))).toBe("host.request")
    expect(named(spans, "agent.turn.begin")).toEqual([])
  })

  test("a failed turn's span ends with its failure code; a turn that could not begin has only its begin span, with the refusal's code", async () => {
    const failed = await Effect.runPromise(traced({ use: () => Effect.fail(new HarnessError({ code: "host.failed", message: "the host gave up" })) }))
    const turn = one(failed.spans, "agent.turn")
    expect(read(turn, ["efferent.outcome", "efferent.failure.code"])).toEqual(["failed", "host.failed"])
    expect(turn.status._tag === "Ended" && Exit.isFailure(turn.status.exit)).toBe(true)
    const unbegun = await Effect.runPromise(traced({ createSession: false }))
    expect(Exit.isFailure(unbegun.exit)).toBe(true)
    expect(named(unbegun.spans, "agent.turn")).toEqual([])
    expect(unbegun.spans.filter((span) => parentName(unbegun.spans, span) === "host.request").map((span) => span.name)).toEqual(["agent.turn.begin"])
    const begin = one(unbegun.spans, "agent.turn.begin")
    expect(read(begin, ["efferent.failure.code", ...ids])).toEqual(["session.missing", conversation, "run-1", undefined])
    expect(begin.status._tag === "Ended" && Exit.isFailure(begin.status.exit)).toBe(true)
  })

  test("logs carry the ids as annotations: the begin's the session and run, the turn's (a tool handler's included) all three, whatever the host's services were captured under", async () => {
    const lines: Array<{ readonly message: string; readonly annotations: Readonly<Record<string, unknown>> }> = []
    const { exit } = await Effect.runPromise(traced({
      // The host's services captured inside its own log-annotated region.
      services: (services) => Effect.context<never>().pipe(
        Effect.map((captured) => Context.merge(captured, services)),
        Effect.flatMap(beginTraced),
        Effect.annotateLogs({ "host.capture": true }),
      ),
      around: (effect) => effect.pipe(Effect.annotateLogs({ "host.tenant": "t-1" }), Effect.provide(capturingLogger(lines)), Effect.provideService(References.MinimumLogLevel, "Debug")),
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    const annotationsOf = (message: string) => lines.filter((line) => line.message === message).map((line) => line.annotations)
    expect(annotationsOf("beginning a turn")).toEqual([{ "host.tenant": "t-1", "efferent.session.id": conversation, "efferent.run.id": "run-1" }])
    expect(annotationsOf("looking a record up")).toEqual([{ "host.tenant": "t-1", "efferent.session.id": conversation, "efferent.run.id": "run-1", "efferent.turn": 1 }])
  })

  test("a turn that fails after its provider calls ends with the usage they spent", async () => {
    const { exit, spans } = await Effect.runPromise(traced({
      use: (turn) => runToEnd()(turn).pipe(Effect.andThen(Effect.fail(new HarnessError({ code: "host.failed", message: "the host gave up after the run" })))),
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(read(one(spans, "agent.turn"), ["efferent.outcome", "efferent.failure.code", "efferent.usage.input_tokens", "efferent.usage.output_tokens", "efferent.usage.total_tokens"]))
      .toEqual(["failed", "host.failed", 300, 30, 330])
  })
})

describe("a turn's refused calls", () => {
  test("a call over the tool's limit is journaled as tool.refused without its input, and listed in step.ended as not ok", async () => {
    const { spans, stored } = await Effect.runPromise(traced())
    const refused = stored.filter((event) => event.kind === "tool.refused")
    expect(refused.map((event) => event.data)).toEqual([{
      step: 1, invocationId: "run-1:call:2", tool: "archive", reason: "tool-call-limit", message: "archive may be called at most 1 times per turn",
    }])
    const ended = stored.find((event) => event.kind === "step.ended" && event.data.step === 1)
    expect((ended?.data.results as ReadonlyArray<{ readonly tool: string; readonly ok: boolean }>).map((result) => [result.tool, result.ok])).toEqual([["archive", true], ["archive", false]])
    // The refused call has its tool span, and no handler ran in it.
    expect(named(spans, "tool.archive")).toHaveLength(2)
    expect(stored.filter((event) => event.kind === "tool.started").map((event) => event.data.invocationId)).toEqual(["run-1:call:0", "run-1:call:1"])
  })
})

describe("trace content", () => {
  const contentOn = (spans: ReadonlyArray<Tracer.NativeSpan>) => named(spans, "engine.turn").map((span) => span.attributes.has("engine.step.input") && span.attributes.has("engine.step.output"))

  test("is off by default", async () => {
    const { spans, reads } = await Effect.runPromise(traced())
    expect(contentOn(spans)).toEqual([false, false, false])
    expect(reads).toEqual([false, false, false])
  })

  test("with neither the agent nor the policy saying, CurrentTraceContent where the run starts decides, for the steps and the model calls", async () => {
    const on = await Effect.runPromise(traced({ use: (turn) => runToEnd()(turn).pipe(Effect.provideService(CurrentTraceContent, true)) }))
    expect(contentOn(on.spans)).toEqual([true, true, true])
    expect(on.reads).toEqual([true, true, true])
    const byAgent = await Effect.runPromise(traced({ config: { captureTraceContent: false }, use: (turn) => runToEnd()(turn).pipe(Effect.provideService(CurrentTraceContent, true)) }))
    expect(contentOn(byAgent.spans)).toEqual([false, false, false])
    expect(byAgent.reads).toEqual([false, false, false])
    const byPolicy = await Effect.runPromise(traced({ use: (turn) => runToEnd({ captureTraceContent: false })(turn).pipe(Effect.provideService(CurrentTraceContent, true)) }))
    expect(contentOn(byPolicy.spans)).toEqual([false, false, false])
    expect(byPolicy.reads).toEqual([false, false, false])
  })

  test("a CurrentTraceContent in the turn's services is where its runs start, under the agent's; a parent span there is ignored", async () => {
    // Services captured under the host's own span (a queue consumer's, say), with the switch on.
    const services = (base: Context.Context<never>) => Effect.context<never>().pipe(
      Effect.map((captured) => Context.add(Context.merge(captured, base), CurrentTraceContent, true)),
      Effect.withSpan("host.queue"),
    )
    const on = await Effect.runPromise(traced({ services }))
    expect(contentOn(on.spans)).toEqual([true, true, true])
    expect(on.reads).toEqual([true, true, true])
    expect(parentName(on.spans, one(on.spans, "agent.turn"))).toBe("host.request")
    expect(on.spans.filter((span) => parentName(on.spans, span) === "host.queue").map((span) => span.name)).toEqual([])
    const byAgent = await Effect.runPromise(traced({ services, config: { captureTraceContent: false } }))
    expect(contentOn(byAgent.spans)).toEqual([false, false, false])
    expect(byAgent.reads).toEqual([false, false, false])
  })

  test("the agent's captureTraceContent turns it on for every run; a policy's overrides it", async () => {
    const on = await Effect.runPromise(traced({ config: { captureTraceContent: true } }))
    expect(contentOn(on.spans)).toEqual([true, true, true])
    expect(on.reads).toEqual([true, true, true])
    expect(String(named(on.spans, "engine.turn")[0]?.attributes.get("engine.step.input"))).toContain("archive alpha")
    const overridden = await Effect.runPromise(traced({ config: { captureTraceContent: true }, use: runToEnd({ captureTraceContent: false }) }))
    expect(contentOn(overridden.spans)).toEqual([false, false, false])
    const byPolicy = await Effect.runPromise(traced({ use: runToEnd({ captureTraceContent: true }) }))
    expect(contentOn(byPolicy.spans)).toEqual([true, true, true])
  })
})

describe("turn metrics", () => {
  const turns = (outcome: string) => Effect.runPromise(Metric.value(Metric.withAttributes(
    Metric.counter("efferent.turns", { description: "turns run by Agent.turn, by outcome", incremental: true }),
    { "efferent.outcome": outcome },
  ))).then((state) => state.count)
  const durations = (outcome: string) => Effect.runPromise(Metric.value(Metric.withAttributes(
    Metric.timer("efferent.turn.duration", { description: "how long each turn Agent.turn ran took, by outcome" }),
    { "efferent.outcome": outcome },
  ))).then((state) => state.count)

  test("efferent.turns and efferent.turn.duration count each admitted turn by outcome", async () => {
    const before = await Promise.all([turns("completed"), turns("failed"), durations("completed"), durations("failed")])
    await Effect.runPromise(traced())
    await Effect.runPromise(traced({ use: () => Effect.fail(new HarnessError({ code: "host.failed", message: "the host gave up" })) }))
    // A turn that could not begin is not counted.
    await Effect.runPromise(traced({ createSession: false }))
    const after = await Promise.all([turns("completed"), turns("failed"), durations("completed"), durations("failed")])
    expect(after.map((count, index) => count - before[index]!)).toEqual([1, 1, 1, 1])
  })
})
