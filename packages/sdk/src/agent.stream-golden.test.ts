import { expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import type { Response } from "effect/ai"
import { Clock, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { join } from "node:path"
import { canonicalJson, ConversationId, CurrentPromptCacheKey, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, LogEntry, replayModelRequest, SessionLogMemoryLive, Sessions, toolParametersSchema, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/*
 * The streamed golden: what a streamed conversation stores and sends back.
 * The model streams the way Anthropic does — a thinking block whose signature
 * arrives on an empty delta, a redacted thinking block whose data arrives on
 * its start, then a tool call — and the next request must carry both blocks
 * with their provider metadata, as it would after a non-streamed response.
 * The journal rebuilds that request byte for byte, and a second agent over
 * the same sessions sends the blocks again from the stored history. Bytes are
 * canonical JSON, as the dispatch check compares them: stored JSON reads back
 * with sorted keys.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const streamHost = defineCapability({
  id: "stream-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`FOUND record-${query}`) })],
  skills: [defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const streamConfig: AgentConfig = {
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  capabilities: [streamHost],
  turnServices: [LanguageModel.LanguageModel],
  limits: { streaming: true, maxSteps: 4 },
  cacheKeyPrefix: "stream-golden",
  system: "STREAM system prefix.",
}

type StreamPart = Response.StreamPartEncoded
const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
const signed = { anthropic: { info: { type: "thinking" as const, signature: "c2lnbmF0dXJlLW9mLXRoZS10aGlua2luZw==" } } }
const redacted = { anthropic: { info: { type: "redacted_thinking" as const, redactedData: "cmVkYWN0ZWQtdGhpbmtpbmc=" } } }

/** Signed thinking, redacted thinking, then a `lookup` call, as Anthropic streams them. */
const thinkThenLookup = (query: string): ReadonlyArray<StreamPart> => [
  { type: "reasoning-start", id: "0" },
  { type: "reasoning-delta", id: "0", delta: "The user wants " },
  { type: "reasoning-delta", id: "0", delta: `${query}: look it up.` },
  { type: "reasoning-delta", id: "0", delta: "", metadata: signed },
  { type: "reasoning-end", id: "0" },
  { type: "reasoning-start", id: "1", metadata: redacted },
  { type: "reasoning-end", id: "1" },
  { type: "tool-params-start", id: "toolu_1", name: "lookup" },
  { type: "tool-params-delta", id: "toolu_1", delta: `{"query":"${query}"}` },
  { type: "tool-params-end", id: "toolu_1" },
  { type: "tool-call", id: "toolu_1", name: "lookup", params: { query }, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]

/** A text answer in two deltas. */
const answerText = (text: string): ReadonlyArray<StreamPart> => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: text.slice(0, 4) },
  { type: "text-delta", id: "0", delta: text.slice(4) },
  { type: "text-end", id: "0" },
  { type: "finish", reason: "stop", usage },
]

const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model that only streams (a settled call would fail the test), recording every request it receives. */
const streamingModel = (requests: Ref.Ref<ReadonlyArray<unknown>>, runId: string, script: ReadonlyArray<ReadonlyArray<StreamPart>>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: () => Effect.die("the streamed golden makes no settled call"),
    streamText: (options) => Stream.unwrap(Effect.gen(function* () {
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
      return Stream.fromIterable(script[index] ?? answerText("done"))
    })),
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

const conversation = ConversationId.make("00000000-0000-4000-8000-00000057e4a1")

/** Run the turn's tools and loop until the model stops. */
const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

const runStreamGolden = Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: conversation, owner: "stream-golden" }
  yield* sessions.create({ owner: address.owner, id: conversation })
  const requests = yield* Ref.make<ReadonlyArray<unknown>>([])
  const input = (runId: string, text: string, model: LanguageModel.LanguageModel) => ({
    turn: { session: address, userMessage: new UserMessage({ text }), runId },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  })

  const first = yield* Agent.define(streamConfig)
  const firstModel = yield* streamingModel(requests, "run-1", [thinkThenLookup("alpha"), answerText("Found record-alpha.")])
  const firstOutcome = yield* first.turn(input("run-1", "find alpha", firstModel), runToStop)

  const second = yield* Agent.define(streamConfig)
  const secondModel = yield* streamingModel(requests, "run-2", [answerText("Nothing more on alpha.")])
  const secondOutcome = yield* second.turn(input("run-2", "anything else?", secondModel), runToStop)

  const stored = yield* sessions.read(address)
  const replayed = yield* replayModelRequest(stored, "run-1", 1)
  return {
    outcomes: [firstOutcome, secondOutcome].map((outcome) => ({ outcome: outcome.outcome, reply: Option.getOrNull(outcome.reply) })),
    requests: yield* Ref.get(requests),
    log: Schema.encodeSync(Schema.Array(LogEntry))(yield* entriesOfEvents(stored)),
    replayed: encodePrompt(replayed.prompt),
  }
})).pipe(Effect.provideService(Clock.Clock, fixedClock))

const modelPath = join(import.meta.dir, "../golden/agent-stream.model.json")

interface EncodedMessage { readonly role: string; readonly content: unknown }
interface EncodedPart { readonly type: string; readonly text?: string; readonly options?: unknown }
const promptOf = (request: unknown): ReadonlyArray<EncodedMessage> => (request as { readonly prompt: { readonly content: ReadonlyArray<EncodedMessage> } }).prompt.content
const assistantParts = (request: unknown): ReadonlyArray<EncodedPart> =>
  promptOf(request).flatMap((message) => message.role === "assistant" && Array.isArray(message.content) ? message.content as ReadonlyArray<EncodedPart> : [])

test("a streamed turn keeps its reasoning's provider metadata: the next request, the journal's rebuild and a second agent send it", async () => {
  const result = await Effect.runPromise(runStreamGolden)
  const [, second, third] = result.requests

  // Request 2 carries both thinking blocks with their metadata, in the order they streamed.
  expect(assistantParts(second).filter((part) => part.type === "reasoning")).toEqual([
    { type: "reasoning", text: "The user wants alpha: look it up.", options: signed },
    { type: "reasoning", text: "", options: redacted },
  ])
  // The journal rebuilds request 2 byte for byte.
  expect(canonicalJson(result.replayed)).toBe(canonicalJson((second as { readonly prompt: unknown }).prompt))
  // The second agent sends turn 1's first assistant message again as request 2 did, from the stored history.
  const thinking = (request: unknown) => canonicalJson(promptOf(request).find((message) => message.role === "assistant"))
  expect(thinking(third)).toBe(thinking(second))

  const actual = `${JSON.stringify({ outcomes: result.outcomes, requests: result.requests, log: result.log }, null, 2)}\n`
  if (process.env.EFFERENT_UPDATE_MODEL_GOLDEN === "1") await Bun.write(modelPath, actual)
  expect(actual).toBe(await Bun.file(modelPath).text())
})
