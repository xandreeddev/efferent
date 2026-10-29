import { LanguageModel, Tool } from "effect/ai"
import type { Response } from "effect/ai"
import { Context, Effect, Layer, Metric, Option, Ref, Schema, Stream, Tracer } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, Failure, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { HarnessError, ModelPrice, Turn, TurnOutcome, TurnResult } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"
import { telemetryPlugin } from "./plugin.adapter.js"
import type { TelemetryOptions } from "./telemetry.entity.js"

/**
 * A key-free turn for the telemetry tests: a host whose `lookup` runs and
 * whose `archive` may run once per turn, and a scripted model that looks
 * alpha up, archives it twice in one response (the second call is refused,
 * `tool-call-limit`) and answers. Every response bills the same usage,
 * stamped with `MODEL` as the models plugin stamps its selection.
 */

export const MODEL = "scripted:telemetry-1"
export const PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
export const conversation = ConversationId.make("00000000-0000-4000-8000-000000000016")

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
  id: "telemetry-host", version: "1",
  tools: [
    defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`found ${query}`) }),
    defineTool({ tool: Archive, handler: ({ id }) => Effect.succeed(`archived ${id}`), annotations: { maxCallsPerRun: Option.some(1) } }),
  ],
  skills: [defineSkill({ id: "records", summary: "Look records up and archive them.", tools: [Lookup.name, Archive.name], always: true })],
})

/** One response's usage: 100 input (30 cache reads, 10 cache writes), 20 output (5 reasoning). */
const usage = { inputTokens: { total: 100, uncached: 60, cacheRead: 30, cacheWrite: 10 }, outputTokens: { total: 20, reasoning: 5 } }
const finish = (reason: "tool-calls" | "stop"): Response.PartEncoded => ({ type: "finish", reason, usage, metadata: { router: { model: MODEL } } })
const script: ReadonlyArray<Array<Response.PartEncoded>> = [
  [{ type: "tool-call", id: "c1", name: Lookup.name, params: { query: "alpha" } }, finish("tool-calls")],
  [
    { type: "tool-call", id: "c2", name: Archive.name, params: { id: "record-alpha" } },
    { type: "tool-call", id: "c3", name: Archive.name, params: { id: "record-alpha-again" } },
    finish("tool-calls"),
  ],
  [{ type: "text", text: "archived record-alpha" }, finish("stop")],
]
export const RESPONSES = script.length

const scripted = Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: () => Ref.getAndUpdate(served, (index) => index + 1).pipe(Effect.map((index) => script[Math.min(index, script.length - 1)]!)),
    // Streamed calls fail before their first part: a run that streams falls back to generateText.
    streamText: () => Stream.die("the stream is down"),
  })
})

/** A tracer keeping every span it starts. */
export const capturingTracer = (spans: Array<Tracer.NativeSpan>) => Tracer.make({
  span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})

/** Activate the always-on skill, then run the turn to its end. */
const runToEnd = (turn: Turn): Effect.Effect<TurnOutcome, HarnessError> =>
  turn.tools.select(turn.userMessage).pipe(
    Effect.andThen(turn.run({})),
    Effect.map((run): TurnOutcome => ({ outcome: run.outcome, reply: Option.some(run.text) })),
  )

/**
 * Define an agent with the telemetry plugin (`options`) and run the
 * scripted turn, its metrics in `registry` (else the ambient one). With `streaming`, every model
 * call is first streamed and falls back. The turn runs under the ambient
 * tracer (an exporter's), or `tracer` when given.
 */
export const scriptedTurn = (options: {
  readonly registry?: Metric.MetricRegistry
  readonly telemetry?: Partial<TelemetryOptions> & Readonly<Record<string, unknown>>
  readonly streaming?: boolean
  readonly tracer?: Tracer.Tracer
}): Effect.Effect<TurnResult, HarnessError> => Effect.scoped(Effect.gen(function* () {
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: telemetryPlugin, options: options.telemetry ?? {} }],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: options.streaming ?? false, maxSteps: 6 },
  })
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: conversation, owner: "test" }
  yield* sessions.create({ owner: address.owner, id: conversation }).pipe(Effect.orDie)
  const model = yield* scripted
  const turn = agent.turn({
    turn: { session: address, userMessage: new UserMessage({ text: "archive alpha" }), runId: "run-1" },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  }, runToEnd)
  return yield* (options.tracer === undefined ? turn : turn.pipe(Effect.withTracer(options.tracer)))
})).pipe((turn) => options.registry === undefined ? turn : turn.pipe(Effect.provideService(Metric.MetricRegistry, options.registry)))

/** A metric's value in `registry`. */
export const valueIn = <Input, State>(registry: Metric.MetricRegistry, metric: Metric.Metric<Input, State>, attributes: Readonly<Record<string, string>>): Effect.Effect<State> =>
  Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))
