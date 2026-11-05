import { afterAll, describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  ModelSpend,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { ModelPrice } from "@xandreed/core"
import {
  defineRunnable,
  EvalId,
  EvaluationError,
  EvaluationRunStore,
  EvaluationServicesLive,
  evaluationEnvironmentPort,
  EvidenceProjector,
  GraderAssessment,
  gradingContext,
  runEvaluation,
  runnableExecutionPort,
  unknownEvaluationUsage,
} from "@xandreed/evals"
import type { EvaluationApp } from "@xandreed/evals"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * An evaluation run whose trials each run an agent turn with the models
 * plugin's spend guard, over the run's spend ledger: the run's budget caps
 * every send of every trial, and once a send is refused under it the run
 * starts no more trials. Input is free and each output token costs 1, so a
 * send holds its output cap (100) and settles at its completion tokens: a
 * turn is a tool call (5) and an answer (2).
 */

const price: ModelPrice = { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
const WORST = 100

const Lookup = Tool.make("lookup", {
  description: "Look a record up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const host = defineCapability({
  id: "eval-spend-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`FOUND record-${query}`) })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"], always: true })],
})

/** A chat-completions endpoint: a tool call (5 completion tokens) to a request without a tool result, else the answer (2). */
const endpoint = () => {
  const requests: Array<unknown> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const body: unknown = await request.json()
      requests.push(body)
      const answered = JSON.stringify(body).includes("FOUND")
      return Response.json(answered
        ? { id: "answer", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Found it." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 } }
        : { id: "call", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: `{"query":"alpha"}` } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })
    },
  })
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}
const server = endpoint()
afterAll(() => server.stop())

const sessionsLayer = SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))

const AgentRunnable = runnableExecutionPort<string, string, Schema.Json, Record<string, never>>("eval-spend-agent")
const AgentEnvironment = evaluationEnvironmentPort<string, Record<string, never>>("eval-spend-agent")

/** One turn of an agent defined over the trial's ledger, on a fresh session: its reply. */
const agentTurn = (text: string) => Effect.scoped(Effect.gen(function* () {
  const ledger = yield* ModelSpend
  const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
      storage: "memory", model: "stub:m", endpoints: { stub: { url: server.url } },
      spend: { prices: { "stub:m": price }, uncappedOutputTokens: WORST },
    } }],
    capabilities: [host],
    services: Context.make(ModelSpend, ledger),
    limits: { streaming: false, maxSteps: 4 },
  })
  const id = ConversationId.make(crypto.randomUUID())
  const session = { owner: "eval-spend", id }
  yield* sessions.create(session)
  const result = yield* agent.turn({
    turn: { session, userMessage: new UserMessage({ text }), runId: RunId.make(`turn-${id}`) },
    services: Context.make(Sessions, sessions),
  }, (current) => current.tools.select(current.userMessage).pipe(
    Effect.andThen(current.run({})),
    Effect.flatMap((run) => current.reply(run.text)),
  ))
  return Option.getOrElse(result.reply, () => "")
})).pipe(Effect.mapError((error) => new EvaluationError({ code: "execution", message: "The agent's turn failed", cause: error })))

const app: EvaluationApp = {
  id: "eval-spend",
  fingerprints: {},
  commands: {},
  calibrations: [],
  suites: [{
    id: EvalId.make("lookups"), version: "1", purpose: "regression", description: "an agent looks a record up",
    repetitions: 3, concurrency: 1, timeoutMs: 10_000,
    tasks: [{
      id: EvalId.make("alpha"), version: "1", runnable: "agent", dataset: "lookups", datasetVersion: "1", family: "lookups",
      split: "validation", review: "known", input: "look alpha up", reference: "Found it.", provenance: "fixture",
      graders: [{ grader: "reply@1", projection: "reply", scope: "trial" }],
    }],
    candidates: [{ id: EvalId.make("agent"), configuration: {}, fingerprints: {} }],
    gates: [],
  }],
  runnables: [defineRunnable({
    definition: { id: EvalId.make("agent"), version: "1", description: "one agent turn", fingerprints: {} },
    input: Schema.String, output: Schema.String, evidence: Schema.Json,
    runnable: AgentRunnable, environment: AgentEnvironment,
    layer: Layer.succeed(AgentRunnable, { execute: (input) => Effect.map(agentTurn(input), (output) => ({ output, evidence: {} })) }),
    environments: [{ id: "memory", layer: Layer.succeed(AgentEnvironment, {
      open: () => Effect.succeed({}),
      inspect: () => Effect.succeed({ state: {}, references: [] }),
    }) }],
  })],
  environmentFor: { agent: "memory" },
  projections: [{
    definition: { id: EvalId.make("reply"), version: "1", budget: { maxBytes: 1_000, reservedBytes: 0 } },
    layer: Layer.succeed(EvidenceProjector, {
      project: (trial) => gradingContext({
        projection: "reply", version: "1", input: Option.getOrNull(trial.output), schema: Schema.Unknown,
        budget: { maxBytes: 1_000, reservedBytes: 0 }, references: [trial.id], omissions: [],
      }),
    }),
  }],
  graders: [{
    definition: { id: EvalId.make("reply"), version: "1", kind: "code", metrics: ["exact"], fingerprints: {} },
    layer: Layer.succeed(GraderAssessment, {
      assess: (context) => Effect.succeed({
        status: "scored", metrics: [{ kind: "boolean", name: "exact", value: context.input === "Found it." }],
        reason: "exact reply", usage: unknownEvaluationUsage, metadata: {},
      }),
    }),
  }],
}

const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void })

describe("journey: an evaluation run's spend budget over the models plugin's spend guard", () => {
  test("trials share the run's budget: a finished trial is kept, the one whose send was refused and the rest are skipped, and each one's spend is recorded", async () => {
    const sent = server.requests.length
    const run = await Effect.runPromise(runEvaluation(app, "spend-journey", { ids: ["lookups"], split: "validation", spendBudget: WORST + 10 }).pipe(
      Effect.provide(Layer.merge(EvaluationServicesLive(app), store)),
    ))
    // The first trial settles 7 (a hold of 100 at 0, then 100 at 5); the
    // second's call holds 100 at 7 and settles 5, its answer would hold 100
    // at 12, past 110, so it is never sent; the third never starts.
    expect(run.trials.map((trial) => [trial.status, trial.spend])).toEqual([
      ["completed", { settled: 7 }],
      ["skipped", { settled: 5 }],
      ["skipped", undefined],
    ])
    expect(run.trials[1]!.reason).toStartWith(`budget: the total model spend cap of ${WORST + 10} would be passed: 12 is settled or held`)
    expect(run.trials[2]!.reason).toStartWith("budget: not run: ")
    expect(server.requests.length - sent).toBe(3)
    expect(run.spend).toEqual({ budget: Option.some(WORST + 10), settled: 12 })
    expect(run.failures).toEqual([])
    expect(run.trials[0]!.grades.map((grade) => grade.metrics)).toEqual([[{ kind: "boolean", name: "exact", value: true }]])
  })

  test("under its budget every trial's turn runs and settles what its sends cost", async () => {
    const run = await Effect.runPromise(runEvaluation(app, "spend-journey-within", { ids: ["lookups"], split: "validation", spendBudget: 1_000 }).pipe(
      Effect.provide(Layer.merge(EvaluationServicesLive(app), store)),
    ))
    expect(run.trials.map((trial) => [trial.status, trial.spend])).toEqual(Array.from({ length: 3 }, () => ["completed", { settled: 7 }]))
    expect(run.spend).toEqual({ budget: Option.some(1_000), settled: 21 })
  })
})
