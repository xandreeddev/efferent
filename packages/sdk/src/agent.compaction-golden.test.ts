import { expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Clock, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { join } from "node:path"
import { ConversationId, CurrentPromptCacheKey, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, LogEntry, replayModelRequest, RunId, RunOrdinal, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import { toolParametersSchema } from "@xandreed/core/internal"
import type { Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/*
 * The compaction golden: what an agent sends once its memory compacts, under
 * a fixed clock. Two conversations, each in its own session and under a small
 * budget: the window strategy spills a result, which the model reads back
 * with `recall_context`, then drops two turns for a host note and a ledger;
 * the summary strategy summarizes the older turns twice, the second time
 * folding the earlier summary in. `golden/agent-compaction.model.json` holds
 * every model and summarizer request, each step's `context.built` and the
 * stored `Compaction` entries, compared as text; it changes only with
 * `EFFERENT_UPDATE_MODEL_GOLDEN=1`. The journal rebuilds the last request of
 * each conversation byte for byte: every request sends params and provider
 * metadata in core's canonical key order, from memory or from the store alike.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query, oldest first.",
  parameters: Schema.Struct({ query: Schema.String, limit: Schema.Number }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** One line per record, oldest first: the `limit` sets how much of the budget a result takes. */
const records = (query: string, limit: number): string =>
  Array.from({ length: limit }, (_, index) => `record-${query}-${String(index + 1).padStart(2, "0")}: ${query} entry ${index + 1}, filed under ${query}`).join("\n")

const compactionHost = defineCapability({
  id: "compaction-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query, limit }) => Effect.succeed(records(query, limit)), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const common = {
  capabilities: [compactionHost],
  limits: { streaming: false, maxSteps: 4 },
  system: "COMPACTION system prefix.",
} satisfies Partial<AgentConfig>

/**
 * Window memory with small spill, preview and ledger sizes. Under its budget
 * the first turn's 60-record result does not fit whole, and the third turn's
 * results fit only once both earlier turns are dropped.
 */
const windowConfig: AgentConfig = {
  ...common,
  plugins: [{ plugin: memoryWindowPlugin, options: { spillMinChars: 1_500, previewChars: 120, ledgerTurnChars: 40 } }, toolDiscoveryPlugin, stepLoopPlugin],
  turnServices: [LanguageModel.LanguageModel],
  cacheKeyPrefix: "compaction-window",
  budgetTokens: 1_250,
}

/**
 * Summary memory that may summarize in consecutive turns. Each turn's
 * results fit the budget, and pass its trigger once the next turn starts.
 * This golden uses pre-request timing; the maintenance journey covers the
 * default after-run lifecycle and its helper accounting.
 */
const summaryConfig: AgentConfig = {
  ...common,
  plugins: [{ plugin: memorySummaryPlugin, options: { cooldownTurns: 0, summarizeAt: "step" } }, toolDiscoveryPlugin, stepLoopPlugin],
  turnServices: [LanguageModel.LanguageModel, UtilityLlm],
  cacheKeyPrefix: "compaction-summary",
  budgetTokens: 1_100,
}

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

const encodePrompt = Schema.encodeSync(Prompt.Prompt)
/** What a step's `context.built` says of its tokens. */
const decodeTokens = Schema.decodeUnknownSync(Schema.Struct({ estimatedTokens: Schema.Int, reservedTokens: Schema.Int, budgetTokens: Schema.Int }))

/** A model request as the golden holds it. */
interface ModelRequest {
  readonly runId: string
  readonly prompt: typeof Prompt.Prompt.Encoded
  readonly tools: ReadonlyArray<unknown>
  readonly toolChoice: unknown
  readonly responseFormat: string
  readonly cacheKey: Option.Option<string>
}

/** A settled model that serves `script` in order, one part per step, recording every request it receives. */
const scripted = (requests: Ref.Ref<ReadonlyArray<ModelRequest>>, runId: string, script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const cacheKey = yield* Effect.service(CurrentPromptCacheKey)
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      yield* Ref.update(requests, (all) => [...all, {
        runId,
        prompt: encodePrompt(options.prompt),
        tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })),
        toolChoice: options.toolChoice,
        responseFormat: options.responseFormat.type,
        cacheKey,
      }])
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("the compaction golden makes no streamed call"),
  })
})

const utilityUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

/** A summarizer that replies `replies` in order, recording every prompt it is asked. */
const summarizer = (asked: Ref.Ref<ReadonlyArray<{ readonly runId: string; readonly prompt: string }>>, runId: string, replies: ReadonlyArray<string>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return UtilityLlm.of({
    complete: (prompt) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      yield* Ref.update(asked, (all) => [...all, { runId, prompt }])
      return new UtilityCompletion({ text: replies[index] ?? "", usage: utilityUsage })
    }),
  })
})

const epoch = 1_767_225_600_000
const realClock = Clock.Clock.defaultValue()
const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => epoch,
  currentTimeMillis: Effect.succeed(epoch),
  currentTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  sleep: (duration) => realClock.sleep(duration),
}

/** Run the turn's tools and loop until the model stops. */
const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

/** One user turn: what the user asks, the model's reply to each step, and the summarizer's to each ask. */
interface ScriptedTurn {
  readonly text: string
  readonly model: ReadonlyArray<Part>
  readonly summaries?: ReadonlyArray<string>
}

/**
 * One conversation of `config` in a fresh session (turn `n` is run `run-n`):
 * the golden part (each turn's outcome, every model and summarizer request,
 * each step's `context.built` and the stored compactions), whether every
 * step fit its budget, the compactions' actions by turn, and the journal's
 * rebuild of the last request (the last turn's last step: each scripted
 * part answers one step).
 */
const runConversation = (config: AgentConfig, id: string, turns: ReadonlyArray<ScriptedTurn>) => Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make(id), owner: "compaction-golden" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  const agent = yield* Agent.define(config)
  const requests = yield* Ref.make<ReadonlyArray<ModelRequest>>([])
  const utility = yield* Ref.make<ReadonlyArray<{ readonly runId: string; readonly prompt: string }>>([])
  const outcomes = yield* Effect.forEach(turns, (scriptedTurn, index) => Effect.gen(function* () {
    const runId = `run-${index + 1}`
    const model = yield* scripted(requests, runId, scriptedTurn.model)
    const summaries = yield* summarizer(utility, runId, scriptedTurn.summaries ?? [])
    const outcome = yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: scriptedTurn.text }), runId: RunId.make(runId) },
      services: Context.mergeAll(Context.make(LanguageModel.LanguageModel, model), Context.make(UtilityLlm, summaries), Context.make(Sessions, sessions)),
    }, runToStop)
    return { outcome: outcome.outcome, reply: Option.getOrNull(outcome.reply) }
  }), { concurrency: 1 })
  const stored = yield* sessions.read(address)
  const compactions = (yield* entriesOfEvents(stored)).filter((entry) => entry.body._tag === "Compaction")
  const built = stored.filter((event) => event.kind === "context.built")
  const replayed = yield* replayModelRequest(stored, RunId.make(`run-${turns.length}`), (turns.at(-1)?.model.length ?? 1) - 1, RunOrdinal.make(0))
  return {
    golden: {
      outcomes,
      requests: yield* Ref.get(requests),
      utility: yield* Ref.get(utility),
      contextBuilt: built.map((event) => event.data),
      compactions: Schema.encodeSync(Schema.Array(LogEntry))(compactions),
    },
    /** Whether every step's messages fit what the budget left them. */
    fits: built.map((event) => decodeTokens(event.data)).every((step) => step.estimatedTokens <= step.budgetTokens - step.reservedTokens),
    actions: compactions.flatMap((entry) => entry.body._tag === "Compaction" ? [{ turn: entry.turn, ...entry.body.action }] : []),
    replayed: encodePrompt(replayed.prompt),
  }
}))

/** The window conversation's first result: the model reads its last two records back by the spill's locator. */
const spilled = records("alpha", 60)
const recallFrom = spilled.indexOf("record-alpha-59")

const runCompactionGolden = Effect.all({
  /**
   * Window: turn 1's lookup is spilled to a preview and the model reads its
   * tail with `recall_context`; turn 3's lookup leaves room for neither
   * earlier turn, and both are dropped for the host note and a ledger.
   */
  window: runConversation(windowConfig, "00000000-0000-4000-8000-0000c0a1e5ce", [
    {
      text: "find the newest alpha record",
      model: [
        call("w1", "lookup", { query: "alpha", limit: 60 }),
        call("w2", "recall_context", { locator: "run-1:4", offset: recallFrom }),
        stop("The newest alpha record is record-alpha-60."),
      ],
    },
    { text: "and the beta records?", model: [call("w3", "lookup", { query: "beta", limit: 3 }), stop("Beta has three records, record-beta-01 to record-beta-03.")] },
    { text: "list the gamma records", model: [call("w4", "lookup", { query: "gamma", limit: 28 }), stop("Gamma has twenty-eight records.")] },
  ]),
  /**
   * Summary: turn 2 starts past the trigger, so turn 1 is summarized and
   * every request of turn 2 carries the handoff; turn 3 starts past it
   * again, and turn 2 is folded into a new summary with the earlier one.
   */
  summary: runConversation(summaryConfig, "00000000-0000-4000-8000-00005a3a1a2e", [
    { text: "find the alpha records", model: [call("s1", "lookup", { query: "alpha", limit: 40 }), stop("Alpha has forty records.")] },
    {
      text: "and the beta records?",
      model: [call("s2", "lookup", { query: "beta", limit: 32 }), stop("Beta has thirty-two records.")],
      summaries: ["The user asked for the alpha records: there are forty, record-alpha-01 to record-alpha-40."],
    },
    {
      text: "which queries have we run?",
      model: [stop("Alpha and beta.")],
      summaries: ["The user asked for the alpha records (forty, record-alpha-01 to record-alpha-40), then the beta records (thirty-two, record-beta-01 to record-beta-32)."],
    },
  ]),
}, { concurrency: 1 }).pipe(Effect.provideService(Clock.Clock, fixedClock))

const modelPath = join(import.meta.dir, "../golden/agent-compaction.model.json")

/** The tool results a request sends, in order. */
const toolResults = (request: ModelRequest | undefined): ReadonlyArray<unknown> =>
  (request?.prompt.content ?? []).flatMap((message) => message.role === "tool" ? message.content : [])

test("a window and a summary conversation compact as the golden holds, and the journal rebuilds each last request", async () => {
  const { window, summary } = await Effect.runPromise(runCompactionGolden)

  // The scenario each conversation is for: a change that loses one fails here, before the bytes.
  expect(window.actions).toMatchObject([{ turn: 1, _tag: "Spill", entry: "run-1:4" }, { turn: 3, _tag: "DropTurns", throughTurn: 2 }])
  expect(summary.actions).toMatchObject([{ turn: 2, _tag: "Summarize", keepFromTurn: 2 }, { turn: 3, _tag: "Summarize", keepFromTurn: 3 }])
  expect(summary.golden.utility.map((ask) => ask.runId)).toEqual(["run-2", "run-3"])
  expect(toolResults(window.golden.requests[2]).at(-1)).toMatchObject({ name: "recall_context", result: spilled.slice(recallFrom) })
  // Every turn completes, and each request has its step's context.built, within the budget.
  expect([window, summary].map(({ golden, fits }) => ({
    outcomes: golden.outcomes.map((outcome) => outcome.outcome), builtPerRequest: golden.contextBuilt.length === golden.requests.length, fits,
  }))).toEqual([window, summary].map(() => ({ outcomes: ["completed", "completed", "completed"], builtPerRequest: true, fits: true })))

  // The journal rebuilds the last request of each conversation byte for byte.
  expect(JSON.stringify(window.replayed)).toBe(JSON.stringify(window.golden.requests.at(-1)?.prompt))
  expect(JSON.stringify(summary.replayed)).toBe(JSON.stringify(summary.golden.requests.at(-1)?.prompt))

  const actual = `${JSON.stringify({ window: window.golden, summary: summary.golden }, null, 2)}\n`
  if (process.env.EFFERENT_UPDATE_MODEL_GOLDEN === "1") await Bun.write(modelPath, actual)
  expect(actual).toBe(await Bun.file(modelPath).text())
})
