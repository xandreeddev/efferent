import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Context, Deferred, Effect, Option, Ref, Result, Schema, Stream } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { pixelPng, sameUsage } from "../conformance.functions.js"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import { Failure } from "../domain/failure.entity.js"
import type { ModelCallPolicy } from "../domain/model-call-policy.entity.js"
import type { FinishReason, StepStatus } from "../domain/turn-vocabulary.entity.js"
import { harnessCodeOf } from "../harness/harness-code.entity.functions.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import type { RunRef } from "../domain/run.entity.js"
import { sumUsage } from "../domain/token-usage.entity.functions.js"
import { CurrentPromptCacheKey } from "../loop/cacheKey.js"
import { CurrentEmptyResponseTolerance, CurrentModelCallPolicy } from "../loop/modelPolicy.js"
import { CurrentAgentRun, CurrentAgentStep } from "../loop/stepContext.js"
import { CurrentTraceContent } from "../loop/traceContent.js"
import { canonicalJson, entryId } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { InitialBatch, ToolChoice } from "../ports/capability.port.js"
import type { LoopLimits, RunResult, StepLoop, StepRequest } from "../ports/step-loop.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import type { TurnTasksService } from "../ports/turn-events.port.js"
import type { TurnError } from "../session/sessions.entity.js"
import { makeTurnEvents, makeTurnTasks } from "./turn-bus.adapter.js"
import type { CompletionVerdict, TurnEvent } from "./turn-event.entity.js"

const Probe = Tool.make("probe", {
  description: "Echo a number.",
  parameters: Schema.Struct({ n: Schema.Finite }),
  success: Schema.Number,
  failure: Failure,
  failureMode: "return",
})
/** Handlers bind to the typed toolkit; the loop sees the erased one, as with the registry. */
const typed = Toolkit.make(Probe)
const erased: ReadonlyArray<Tool.Any> = [Probe]
const toolkit = Toolkit.make(...erased)

type Part = Response.PartEncoded
const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }
/** The run the scenarios' tail entries are recorded under. */
const RUN = RunId.make("conformance")
/** The run a scenario is, unless it names another: the first of turn 1. */
const FIRST_RUN: RunRef = { id: RUN, turn: 1, ordinal: RunOrdinal.make(0) }
/**
 * A scripted provider reply calling `probe`.
 *
 * @public
 */
export const probeCall = (id: string, n: number): ReadonlyArray<Part> => [
  { type: "tool-call", id, name: Probe.name, params: { n }, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]
/** @public */
export const textReply = (text: string): ReadonlyArray<Part> => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
/** A scripted provider reply the model could not form: a call to a tool that does not exist. */
const malformedCall = (id: string): ReadonlyArray<Part> => [
  { type: "tool-call", id, name: "no_such_tool", params: {}, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]

type StreamPart = Response.StreamPartEncoded
/** Anthropic's thinking metadata: the signature of a thinking block, the data of a redacted one. */
const signed = { anthropic: { info: { type: "thinking" as const, signature: "conformance-signature" } } }
const redacted = { anthropic: { info: { type: "redacted_thinking" as const, redactedData: "conformance-redacted" } } }
/** A reply that thinks, signed and redacted, before it calls `probe`: settled, then as Anthropic streams it
 *  (the signature on an empty delta after the text, the redacted data on its block's start). */
const thinkingProbeCall = (id: string, n: number): ReadonlyArray<Part> =>
  [{ type: "reasoning", text: "think", metadata: signed }, { type: "reasoning", text: "", metadata: redacted }, ...probeCall(id, n)]
const streamedThinkingProbeCall = (id: string, n: number): ReadonlyArray<StreamPart> => [
  { type: "reasoning-start", id: "0" },
  { type: "reasoning-delta", id: "0", delta: "think" },
  { type: "reasoning-delta", id: "0", delta: "", metadata: signed },
  { type: "reasoning-end", id: "0" },
  { type: "reasoning-start", id: "1", metadata: redacted },
  { type: "reasoning-end", id: "1" },
  { type: "tool-call", id, name: Probe.name, params: { n }, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]
const streamedText = (text: string): ReadonlyArray<StreamPart> =>
  [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", reason: "stop", usage }]
/**
 * A reply cut short for `reason` after it called `probe` twice (`<prefix>1`, `<prefix>2`), the same parts
 * settled and streamed: streamed one part at a time, the second call arrives after the first, and the
 * finish that says the reply was cut after both.
 */
const cutParts = (reason: FinishReason, prefix: string) => [
  { type: "tool-call" as const, id: `${prefix}1`, name: Probe.name, params: { n: 1 }, providerExecuted: false },
  { type: "tool-call" as const, id: `${prefix}2`, name: Probe.name, params: { n: 2 }, providerExecuted: false },
  { type: "finish" as const, reason, usage },
]
const cutCalls = (reason: FinishReason, prefix: string): ReadonlyArray<Part> => cutParts(reason, prefix)
const streamedCutCalls = (reason: FinishReason, prefix: string): ReadonlyArray<StreamPart> => cutParts(reason, prefix)
/** A reply the provider paused, for its next call to continue. */
const pausedReply = (text: string): ReadonlyArray<Part> => [{ type: "text", text }, { type: "finish", reason: "pause", usage }]
/** A reply of text alone, with no tool call, cut short for `reason`. */
const cutText = (reason: FinishReason, text: string): ReadonlyArray<Part> => [{ type: "text", text }, { type: "finish", reason, usage }]
/** `reply` as a provider that ended it without saying why gives it: with no finish part, its finish reason reads `unknown`. */
const unfinished = (reply: ReadonlyArray<Part>): ReadonlyArray<Part> => reply.filter((part) => part.type !== "finish")
/** `reply` with a finish part that says `unknown`. */
const finishedUnknown = (reply: ReadonlyArray<Part>): ReadonlyArray<Part> =>
  reply.map((part) => part.type === "finish" ? { ...part, reason: "unknown" as const } : part)
/** `reply` after a text part of `text`, as a model writes before its calls. */
const afterText = (text: string, reply: ReadonlyArray<Part>): ReadonlyArray<Part> => [{ type: "text", text }, ...reply]
/** A reply of `text` and a call the provider ran itself (`providerExecuted`), with no finish part: it holds no call for the loop to run. */
const providerExecutedReply = (text: string): ReadonlyArray<Part> =>
  [{ type: "text", text }, { type: "tool-call", id: "pe1", name: Probe.name, params: { n: 1 }, providerExecuted: true }]
/** The reasons but the output limit a reply can be cut short for: the loop corrects none of them. */
const UNCORRECTED_CUTS: ReadonlyArray<FinishReason> = ["content-filter", "error", "other"]

/** A provider's usage with every count: cache reads and writes inside the input, reasoning inside the output. */
const billed = (input: number, output: number) => ({
  inputTokens: { total: input, uncached: input - 30, cacheRead: 20, cacheWrite: 10 },
  outputTokens: { total: output, text: output - 3, reasoning: 3 },
})
/** The same reply with another usage on its finish part. */
const withUsage = (reply: ReadonlyArray<Part>, value: ReturnType<typeof billed>): ReadonlyArray<Part> =>
  reply.map((part) => part.type === "finish" ? { ...part, usage: value } : part)

interface Scenario {
  readonly degenerate?: LoopLimits["degenerate"]
  readonly malformedLimit?: number
  readonly script: ReadonlyArray<ReadonlyArray<Part>>
  readonly initial?: InitialBatch
  readonly toolChoice?: ToolChoice
  readonly maxSteps?: number
  readonly completion?: (step: number, tasks: TurnTasksService) => Effect.Effect<CompletionVerdict, HarnessError>
  readonly before?: (tasks: TurnTasksService) => Effect.Effect<void>
  readonly dispatch?: (step: number) => Effect.Effect<void, HarnessError>
  readonly providerCall?: Effect.Effect<void>
  /** A typed model failure, before a response or stream part arrives. */
  readonly failure?: AiError.AiError
  /** Runs inside each probe handler, before it returns its result. */
  readonly handle?: (n: number) => Effect.Effect<void>
  /** Reject a record before it is stored, as a durable writer can. */
  readonly recording?: (step: number, tail: ReadonlyArray<AgentMessage>) => Effect.Effect<void, TurnError>
  /** Runs after each record is stored. */
  readonly recorded?: (step: number, tail: ReadonlyArray<AgentMessage>) => Effect.Effect<void, TurnError>
  readonly toolConcurrency?: number
  /** The request's `captureTraceContent` (off by default). */
  readonly captureTraceContent?: boolean
  /** `CurrentTraceContent` where the loop runs and in the request's services (off by default). */
  readonly ambientTraceContent?: boolean
  /** The request's `cacheKey` (none by default). */
  readonly cacheKey?: Option.Option<string>
  /** `CurrentPromptCacheKey` where the loop runs and in the request's services (none by default). */
  readonly ambientCacheKey?: Option.Option<string>
  /** The request's `callPolicy` (none by default). */
  readonly callPolicy?: Option.Option<ModelCallPolicy>
  /** `CurrentModelCallPolicy` where the loop runs and in the request's services (none by default). */
  readonly ambientCallPolicy?: Option.Option<ModelCallPolicy>
  /** `CurrentEmptyResponseTolerance` where the loop runs and in the request's services (off by default). */
  readonly ambientTolerance?: boolean
  /** `CurrentAgentStep` where the loop runs and in the request's services (none by default). */
  readonly ambientStep?: Option.Option<number>
  readonly ambientRun?: Option.Option<RunRef>
  /** The provider refuses its first request over an image (an `InvalidRequestError` naming one). */
  readonly refuseFirst?: boolean
  /** The request's `onMediaRejected` (answers false by default). */
  readonly onMediaRejected?: (reason: string) => Effect.Effect<boolean>
  /** Runs on every `plan` call, with the step it plans. */
  readonly planned?: (step: number) => Effect.Effect<void>
  /** The request's `limits.streaming` (off by default). */
  readonly streaming?: boolean
  /** What the provider streams for each call, one part at a time with a yield on each, the streamed twin of `script`; without it, the provider does not stream. */
  readonly stream?: ReadonlyArray<ReadonlyArray<StreamPart>>
  /** Each plan holds the messages recorded so far after the user's, as a memory renders them (only the user's by default). */
  readonly replay?: boolean
  /** The request's `run` (`FIRST_RUN` by default). */
  readonly run?: RunRef
  /** What the request's `steering` answers, one text per consult, then none (none by default). */
  readonly steering?: ReadonlyArray<string>
  /** Durable queued messages, delivered at the named boundary. */
  readonly durableSteering?: {
    readonly at: "initial" | "completion" | "settled" | "empty-probe"
    readonly messages: ReadonlyArray<AgentMessage>
    readonly failure?: TurnError
  }
  /** The request's `limits.requireCompletion` (off by default). */
  readonly requireCompletion?: boolean
}

/** A provider's refusal of a request over an image. */
const imageRefusal = AiError.make({
  module: "Conformance", method: "generateText",
  reason: new AiError.InvalidRequestError({ description: "messages.0.content.0.image: the image could not be processed" }),
})

interface Observed {
  readonly result: RunResult
  readonly events: ReadonlyArray<TurnEvent>
  /** Each `record` call, in order: the step it recorded under, and how many events were published before it. */
  readonly records: ReadonlyArray<{ readonly step: number; readonly after: number }>
  readonly providerCalls: ReadonlyArray<unknown>
  /** The prompt of each provider call. */
  readonly prompts: ReadonlyArray<Prompt.Prompt>
  readonly recorded: ReadonlyArray<LogEntry>
  /** The durable log when each tool handler began. */
  readonly atHandlers: ReadonlyArray<ReadonlyArray<LogEntry>>
  readonly durable: {
    readonly pending: ReadonlyArray<AgentMessage>
    readonly taken: ReadonlyArray<{ readonly step: number; readonly after: number }>
    readonly probes: number
  }
  readonly dispatches: ReadonlyArray<number>
  /** `CurrentTraceContent` as each provider call read it. */
  readonly traceContent: ReadonlyArray<boolean>
  /** `CurrentPromptCacheKey` as each dispatch check, then each provider call, read it. */
  readonly cacheKeys: { readonly dispatched: ReadonlyArray<Option.Option<string>>; readonly called: ReadonlyArray<Option.Option<string>> }
  /** `CurrentModelCallPolicy` as each dispatch check, then each provider call, read it. */
  readonly callPolicies: { readonly dispatched: ReadonlyArray<Option.Option<ModelCallPolicy>>; readonly called: ReadonlyArray<Option.Option<ModelCallPolicy>> }
  /** `CurrentEmptyResponseTolerance` as each provider call read it. */
  readonly tolerance: ReadonlyArray<boolean>
  /** `CurrentAgentStep` as each `probe` handler, then each provider call, read it. */
  readonly steps: { readonly handled: ReadonlyArray<Option.Option<number>>; readonly called: ReadonlyArray<Option.Option<number>> }
  readonly runs: { readonly handled: ReadonlyArray<Option.Option<RunRef>>; readonly called: ReadonlyArray<Option.Option<RunRef>> }
}

const incomplete: CompletionVerdict = { complete: false, awaiting: [], facts: {} }

/** What a scenario's run observed, the run's failure included. */
type ObservedRun = Omit<Observed, "result"> & { readonly result: Result.Result<RunResult, TurnError> }

/** Run one scenario on the loop with a scripted provider, the `probe` tool and an in-memory record. */
const observeRun = (loop: Context.Service.Shape<typeof StepLoop>, scenario: Scenario): Effect.Effect<ObservedRun> => Effect.scoped(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const events = yield* makeTurnEvents({ maxDepth: 8 })
  const tasks = yield* makeTurnTasks(scope)
  const seen = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
  const waitingSteers = yield* Ref.make<ReadonlyArray<AgentMessage>>(scenario.durableSteering?.at === "initial" ? scenario.durableSteering.messages : [])
  const deliveredSteers = yield* Ref.make(scenario.durableSteering?.at === "initial")
  const takenSteers = yield* Ref.make<ReadonlyArray<{ readonly step: number; readonly after: number }>>([])
  const steerProbes = yield* Ref.make(0)
  const deliverSteers = Ref.getAndSet(deliveredSteers, true).pipe(Effect.flatMap((delivered) => delivered ? Effect.void : Ref.update(waitingSteers, (all) => [...all, ...(scenario.durableSteering?.messages ?? [])])))
  yield* events.subscribe(Option.some, (event: TurnEvent) => Ref.update(seen, (all) => [...all, event]).pipe(
    Effect.andThen(event._tag === "step.ended" && scenario.durableSteering?.at === "settled" ? deliverSteers : Effect.void),
  ))
  const calls = yield* Ref.make<ReadonlyArray<unknown>>([])
  const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
  const dispatches = yield* Ref.make<ReadonlyArray<number>>([])
  const traceContent = yield* Ref.make<ReadonlyArray<boolean>>([])
  const dispatchedKeys = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
  const calledKeys = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
  const dispatchedPolicies = yield* Ref.make<ReadonlyArray<Option.Option<ModelCallPolicy>>>([])
  const calledPolicies = yield* Ref.make<ReadonlyArray<Option.Option<ModelCallPolicy>>>([])
  const tolerance = yield* Ref.make<ReadonlyArray<boolean>>([])
  const handledSteps = yield* Ref.make<ReadonlyArray<Option.Option<number>>>([])
  const calledSteps = yield* Ref.make<ReadonlyArray<Option.Option<number>>>([])
  const handledRuns = yield* Ref.make<ReadonlyArray<Option.Option<RunRef>>>([])
  const calledRuns = yield* Ref.make<ReadonlyArray<Option.Option<RunRef>>>([])
  const recorded = yield* Ref.make<ReadonlyArray<LogEntry>>([])
  const atHandlers = yield* Ref.make<ReadonlyArray<ReadonlyArray<LogEntry>>>([])
  /** Append what `reference` reads where this runs. */
  const read = <A>(reference: Context.Reference<A>, into: Ref.Ref<ReadonlyArray<A>>) =>
    Effect.service(reference).pipe(Effect.flatMap((value) => Ref.update(into, (all) => [...all, value])))
  /** One provider call, streamed or not: its index, after it is recorded. */
  const called = (options: LanguageModel.ProviderOptions) => Ref.modify(calls, (all): [number, ReadonlyArray<unknown>] => [all.length, [...all, options.toolChoice]]).pipe(
    Effect.tap(() => Ref.update(prompts, (all) => [...all, options.prompt])),
    Effect.tap(() => scenario.providerCall ?? Effect.void),
    Effect.tap(() => read(CurrentTraceContent, traceContent)),
    Effect.tap(() => read(CurrentPromptCacheKey, calledKeys)),
    Effect.tap(() => read(CurrentModelCallPolicy, calledPolicies)),
    Effect.tap(() => read(CurrentEmptyResponseTolerance, tolerance)),
    Effect.tap(() => read(CurrentAgentStep, calledSteps)),
    Effect.tap(() => read(CurrentAgentRun, calledRuns)),
  )
  const stream = scenario.stream
  const model = yield* LanguageModel.make({
    generateText: (options) => called(options).pipe(
      Effect.flatMap((index) => scenario.failure !== undefined ? Effect.fail(scenario.failure) : scenario.refuseFirst === true && index === 0
        ? Effect.fail(imageRefusal)
        : Effect.succeed([...(scenario.script[index] ?? textReply("done"))])),
    ),
    streamText: (options) => scenario.failure !== undefined
      ? Stream.unwrap(called(options).pipe(Effect.as(Stream.fail(scenario.failure)))) : stream === undefined
      ? Stream.die("the conformance provider does not stream")
      // One part per chunk, the fiber yielding on each, as a provider streams them over the wire: what a part
      // sets off (a tool handler that effect/ai's own resolution forks once the next part arrives) gets to
      // start before the finish arrives.
      : Stream.unwrap(called(options).pipe(Effect.map((index) =>
        Stream.fromIterable(stream[index] ?? streamedText("done"), { chunkSize: 1 }).pipe(Stream.tap(() => Effect.yieldNow))))),
  })
  const invocations = yield* Ref.make(0)
  const handlers = yield* typed.toHandlers({
    probe: ({ n }) => Effect.gen(function* () {
      yield* Ref.get(recorded).pipe(Effect.flatMap((entries) => Ref.update(atHandlers, (all) => [...all, entries])))
      const current = yield* Effect.service(CurrentAgentStep)
      yield* Ref.update(handledSteps, (all) => [...all, current])
      yield* read(CurrentAgentRun, handledRuns)
      const step = Option.getOrElse(current, () => -1)
      const invocationId = InvocationId.make(`probe:${yield* Ref.getAndUpdate(invocations, (value) => value + 1)}`)
      const base = { step, invocationId, tool: Probe.name, input: { n }, labels: {}, stage: Option.none() }
      yield* events.publish({ _tag: "tool.started", ...base }).pipe(Effect.orDie)
      yield* scenario.handle?.(n) ?? Effect.void
      yield* events.publish({ _tag: "tool.completed", ...base, ok: true, result: n, encoded: n, durationMs: 0 }).pipe(Effect.orDie)
      return n
    }),
  })
  const tools: RunTools = {
    toolkit,
    handlers,
    active: Effect.succeed([Probe.name]),
    activate: () => Effect.succeed([Probe.name]),
    match: (userMessage) => Effect.succeed({ userMessage, skills: [], probabilities: Option.none(), record: Option.none() }),
    apply: () => Effect.succeed([Probe.name]),
    select: () => Effect.succeed([Probe.name]),
    views: {
      view: (_tool, encoded) => Effect.succeed({ text: String(encoded), version: "1", subjects: [], artifacts: [], pinned: false }),
      compact: () => Effect.succeed(Option.none()),
      digest: () => Effect.succeed(Option.none()),
    },
    pollable: [],
    skills: [],
  }
  const records = yield* Ref.make<ReadonlyArray<{ readonly step: number; readonly after: number }>>([])
  const history = yield* Ref.make<ReadonlyArray<AgentMessage>>([{ role: "user", content: "go" }])
  const steers = yield* Ref.make(scenario.steering ?? [])
  const record = (step: number, tail: ReadonlyArray<AgentMessage>) => (scenario.recording?.(step, tail) ?? Effect.void).pipe(Effect.andThen(Ref.get(seen)),
    Effect.flatMap((published) => Ref.update(records, (all) => [...all, { step, after: published.length }])),
    Effect.andThen(Ref.update(history, (all) => [...all, ...tail])),
  ).pipe(Effect.andThen(Ref.modify(recorded, (all): [ReadonlyArray<LogEntry>, ReadonlyArray<LogEntry>] => {
    const entries = tail.flatMap((message): ReadonlyArray<LogEntry["body"]> => message.role !== "tool"
      ? [{ _tag: "Message", message }]
      : message.content.map((part) => ({
        _tag: "ToolResult", toolCallId: part.toolCallId, toolName: part.toolName, isError: part.isError ?? false,
        encoded: part.output, view: String(part.output), viewVersion: "1", subjects: [], artifacts: [], pinned: false,
      }))).map((body, index): LogEntry => ({ id: entryId(RUN, all.length + index), runId: RUN, turn: 1, step, at: 0, body }))
    return [entries, [...all, ...entries]]
  })), Effect.tap(() => scenario.recorded?.(step, tail) ?? Effect.void))
  yield* scenario.before?.(tasks) ?? Effect.void
  const request: StepRequest = {
    run: scenario.run ?? FIRST_RUN,
    tools,
    // The caller's values of `StepLoopReferences` are in the request's services too, as a turn's
    // services capture the context it runs in: the loop's own values must win over them as well.
    handlers: Context.merge(handlers, Context.make(LanguageModel.LanguageModel, model)).pipe(
      Context.add(CurrentPromptCacheKey, scenario.ambientCacheKey ?? Option.none()),
      Context.add(CurrentTraceContent, scenario.ambientTraceContent ?? false),
      Context.add(CurrentModelCallPolicy, scenario.ambientCallPolicy ?? Option.none()),
      Context.add(CurrentEmptyResponseTolerance, scenario.ambientTolerance ?? false),
      Context.add(CurrentAgentStep, scenario.ambientStep ?? Option.none()),
      Context.add(CurrentAgentRun, scenario.ambientRun ?? Option.none()),
    ),
    limits: {
      maxSteps: scenario.maxSteps ?? 6, toolConcurrency: scenario.toolConcurrency ?? 1, streaming: scenario.streaming ?? false, requireCompletion: scenario.requireCompletion ?? false,
      ...(scenario.degenerate === undefined ? {} : { degenerate: scenario.degenerate }),
      ...(scenario.malformedLimit === undefined ? {} : { malformedLimit: scenario.malformedLimit }),
    },
    initial: Option.fromNullishOr(scenario.initial),
    plan: (info) => (scenario.planned?.(info.stepIndex) ?? Effect.void).pipe(
      Effect.andThen(scenario.replay === true ? Ref.get(history) : Effect.succeed([{ role: "user" as const, content: "go" }])),
      Effect.map((messages) => ({ model: Option.none(), system: "conformance", messages, toolChoice: Option.fromNullishOr(scenario.toolChoice) })),
    ),
    dispatch: (step) => Ref.update(dispatches, (all) => [...all, step]).pipe(
      Effect.andThen(read(CurrentPromptCacheKey, dispatchedKeys)),
      Effect.andThen(read(CurrentModelCallPolicy, dispatchedPolicies)),
      Effect.andThen(scenario.dispatch?.(step) ?? Effect.void),
    ),
    record,
    recorded: (step) => Ref.get(recorded).pipe(Effect.map((all) => all.filter((entry) => entry.step === step))),
    onMediaRejected: scenario.onMediaRejected ?? (() => Effect.succeed(false)),
    completion: (info) => (scenario.completion?.(info.stepIndex, tasks) ?? Effect.succeed(incomplete)).pipe(Effect.tap(() => scenario.durableSteering?.at === "completion" ? deliverSteers : Effect.void)),
    pendingSteers: Ref.update(steerProbes, (count) => count + 1).pipe(Effect.andThen(Ref.get(waitingSteers)), Effect.flatMap((waiting) =>
      waiting.length === 0 && scenario.durableSteering?.at === "empty-probe"
        ? Ref.get(calls).pipe(Effect.flatMap((called) => called.length > 0 ? deliverSteers : Effect.void), Effect.as(false))
        : Effect.succeed(waiting.length > 0))),
    steer: Effect.fnUntraced(function* (step: number) {
      const messages = yield* Ref.get(waitingSteers)
      if (messages.length === 0) return []
      if (scenario.durableSteering?.failure !== undefined) return yield* Effect.fail(scenario.durableSteering.failure)
      const published = yield* Ref.get(seen)
      yield* Ref.update(takenSteers, (all) => [...all, { step, after: published.length }])
      yield* record(step, messages)
      yield* Ref.set(waitingSteers, [])
      return messages
    }),
    steering: Ref.modify(steers, (texts): [Option.Option<string>, ReadonlyArray<string>] => [Option.fromNullishOr(texts[0]), texts.slice(1)]),
    correctives: Option.none(),
    events,
    tasks,
    cacheKey: scenario.cacheKey ?? Option.none(),
    callPolicy: scenario.callPolicy ?? Option.none(),
    captureTraceContent: scenario.captureTraceContent ?? false,
  }
  // The caller's values of the references the loop provides (`StepLoopReferences`), set even when they are the
  // defaults: the loop's own win, also in the callbacks it runs with the caller's services.
  const result = yield* Effect.result(loop.run(request).pipe(
    Effect.provideService(CurrentPromptCacheKey, scenario.ambientCacheKey ?? Option.none()),
    Effect.provideService(CurrentTraceContent, scenario.ambientTraceContent ?? false),
    Effect.provideService(CurrentModelCallPolicy, scenario.ambientCallPolicy ?? Option.none()),
    Effect.provideService(CurrentEmptyResponseTolerance, scenario.ambientTolerance ?? false),
    Effect.provideService(CurrentAgentStep, scenario.ambientStep ?? Option.none()),
    Effect.provideService(CurrentAgentRun, scenario.ambientRun ?? Option.none()),
  ))
  return {
    result, events: yield* Ref.get(seen), records: yield* Ref.get(records), providerCalls: yield* Ref.get(calls), prompts: yield* Ref.get(prompts), recorded: yield* Ref.get(recorded), atHandlers: yield* Ref.get(atHandlers),
    durable: { pending: yield* Ref.get(waitingSteers), taken: yield* Ref.get(takenSteers), probes: yield* Ref.get(steerProbes) },
    dispatches: yield* Ref.get(dispatches), traceContent: yield* Ref.get(traceContent),
    cacheKeys: { dispatched: yield* Ref.get(dispatchedKeys), called: yield* Ref.get(calledKeys) },
    callPolicies: { dispatched: yield* Ref.get(dispatchedPolicies), called: yield* Ref.get(calledPolicies) },
    tolerance: yield* Ref.get(tolerance),
    steps: { handled: yield* Ref.get(handledSteps), called: yield* Ref.get(calledSteps) },
    runs: { handled: yield* Ref.get(handledRuns), called: yield* Ref.get(calledRuns) },
  }
}))

/** `observeRun` of a run that must succeed: its failure fails the check. */
const observe = (loop: Context.Service.Shape<typeof StepLoop>, scenario: Scenario): Effect.Effect<Observed, ConformanceFailure> =>
  observeRun(loop, scenario).pipe(Effect.flatMap((observed) => Result.match(observed.result, {
    onFailure: (error) => Effect.fail(new ConformanceFailure({ check: "run", message: error.message })),
    onSuccess: (result) => Effect.succeed({ ...observed, result }),
  })))

const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> =>
  holds ? Effect.void : Effect.fail(new ConformanceFailure({ check, message }))

const stepOf = (event: TurnEvent): Option.Option<number> => event._tag === "model.called" ? event.step : "step" in event ? Option.some(event.step) : Option.none()
const indexOf = (events: ReadonlyArray<TurnEvent>, tag: TurnEvent["_tag"], step: number) =>
  events.findIndex((event) => event._tag === tag && Option.contains(stepOf(event), step))
/** The status of each `step.ended`, in order. */
const statusesOf = (events: ReadonlyArray<TurnEvent>): ReadonlyArray<StepStatus> =>
  events.flatMap((event) => event._tag === "step.ended" ? [event.status] : [])
/** The finish reason of each `assistant.message`, in order. */
const finishReasonsOf = (events: ReadonlyArray<TurnEvent>): ReadonlyArray<FinishReason> =>
  events.flatMap((event) => event._tag === "assistant.message" ? [event.finishReason] : [])
/** Whether a run failed with the framework's `code`. */
const failedWith = (result: Result.Result<RunResult, TurnError>, code: string): boolean =>
  Result.match(result, { onFailure: (error) => Option.contains(harnessCodeOf(error), code), onSuccess: () => false })
/** How a run ended, in words. */
const endingOf = (result: Result.Result<RunResult, TurnError>): string => Result.match(result, {
  onFailure: (error) => `failed with ${Option.getOrElse(harnessCodeOf(error), () => error._tag)}: ${error.message}`,
  onSuccess: (done) => `ended ${done.outcome} with ${JSON.stringify(done.text)}`,
})

/**
 * What a run shows whose first reply, cut at the output limit, called
 * `probe` twice (`cut1`, `cut2`), and whose next reply is `done`: no handler
 * ran; each call is answered by a recorded failure, which `step.ended` lists
 * as not ok; the step ended `truncated`, with no `completion.evaluated`; its
 * `assistant.message` carried `length`; the next request held a user message
 * of the loop's, recorded under the next step, after those results; and the
 * run completed with `done`.
 */
const expectCut = (check: string, observed: Observed) => Effect.gen(function* () {
  const { events, prompts, recorded, result, steps } = observed
  const toolEvents = events.filter((event) => event._tag === "tool.started" || event._tag === "tool.completed").length
  yield* expect(check, steps.handled.length === 0 && toolEvents === 0,
    `the cut reply's calls ran: ${steps.handled.length} probe handler calls, ${toolEvents} tool events`)
  const answers = recorded.flatMap((entry) => entry.step === 0 && entry.body._tag === "ToolResult"
    ? [{ entry: String(entry.id), call: String(entry.body.toolCallId), failed: entry.body.isError }]
    : [])
  yield* expect(check, answers.map((answer) => answer.call).join() === "cut1,cut2" && answers.every((answer) => answer.failed),
    `the cut reply's calls cut1, cut2 were answered ${JSON.stringify(answers)}, not with a failure each`)
  const ends = events.flatMap((event) => event._tag === "step.ended" && event.step === 0 ? [event] : [])
  const listed = ends.flatMap((event) => event.results.map((listedResult) => ({ entry: String(listedResult.entry), ok: listedResult.ok })))
  yield* expect(check, ends.map((event) => event.status).join() === "truncated"
    && listed.map((entry) => entry.entry).join() === answers.map((answer) => answer.entry).join() && listed.every((entry) => !entry.ok),
    `step 0 ended ${JSON.stringify(ends.map((event) => event.status))}, listing ${JSON.stringify(listed)}, not truncated with its ${answers.length} answers not ok`)
  yield* expect(check, indexOf(events, "completion.evaluated", 0) < 0, "the cut step's completion was evaluated")
  yield* expect(check, finishReasonsOf(events).join() === "length,stop",
    `the assistant messages carried the finish reasons ${JSON.stringify(finishReasonsOf(events))}, not [length,stop]`)
  const next = prompts[1]?.content ?? []
  const answered = next.findIndex((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.id === "cut2"))
  const corrective = next.findLastIndex((message) => message.role === "user")
  const recordedUnderNext = recorded.some((entry) => entry.step === 1 && entry.body._tag === "Message" && entry.body.message.role === "user")
  yield* expect(check, prompts.length === 2 && answered >= 0 && corrective > answered && recordedUnderNext,
    `the request after the cut reply held ${JSON.stringify(next.map((message) => message.role))}, ${recordedUnderNext ? "" : "nothing of the loop's recorded under step 1, "}not a user message after the cut calls' results`)
  yield* expect(check, result.outcome === "completed" && result.text === "done", `the run ended ${result.outcome} with ${JSON.stringify(result.text)}, not completed with "done"`)
})

/**
 * The `StepLoop` contract, as checks any implementation must pass:
 * per-step event order, recorded results on `step.ended`, each step ended
 * once, with its assistant response durable and usage published before any
 * handler runs, and each result durable as it returns while a sibling may
 * still be held; a failed record stops the execution and fails the step;
 * nothing recorded under it after its `step.ended` (the loop's
 * correctives, nudges and steers are the next step's, the corrective after
 * a reply cut at the output limit among them), nothing recorded under a
 * step that never starts (the step cap or a complete verdict ending the run
 * with a corrective or a nudge due, the cap at a reply cut at the output
 * limit, of text alone or with calls, included), a step whose
 * completion fails afterwards still `completed`, a malformed step ended
 * `malformed` with no `completion.evaluated`, a reply cut short (a finish
 * reason but `stop`, `tool-calls` and `pause`; `unknown`, the provider
 * giving none, only in a reply with tool calls to run) running none of its
 * tool calls, settled or streamed one part at a time (a call followed by
 * another part before the finish included), each answered by a recorded
 * failure that `step.ended` lists as not ok, its step ended `truncated` with
 * no `completion.evaluated` (`cut`, `cut-stream`), a reply cut at the output
 * limit answered with a corrective of the loop's, after its calls' results
 * in the next request and recorded under the next step, at most twice in a
 * row: a third, or a reply cut for any other reason (`content-filter`,
 * `error`, `other`; one of text alone included), fails the run with
 * `loop.truncated` (`cut-fail`), a malformed or a whole step between cuts
 * at the output limit restarting their count in a row, and a cut step the
 * count of malformed steps in a row (malformed, cut, malformed, malformed
 * goes on) (`cut-reset`), a reply that calls a tool with no finish reason
 * failing the run the same way, while a text reply with none, one beside a
 * call the provider ran itself (no call for the loop to run) included,
 * completes it (`cut-unknown`), a reply of text alone cut at the
 * output limit ending its step `truncated` and answered with a corrective
 * to go on from it (not the one after a cut reply's calls), its text the
 * start of the run's, the next reply's following it, and the run's text when
 * the step cap ends the run there, while the text of a reply cut with calls
 * in it is not carried: the run's text is the next reply's (`cut-text`), a
 * paused reply going on to the next step, its text the start of the run's
 * (`pause`), every `assistant.message` carrying its response's finish
 * reason (`finish`), planned batches
 * without a provider call, forced tool choices, awaiting verdicts, no call
 * after completion, the run's usage, the step cap, each of
 * `StepLoopReferences` provided whatever the caller's, around the run and
 * in the request's services alike (the request's
 * `captureTraceContent` to its model calls as `CurrentTraceContent`, its
 * `cacheKey` and `callPolicy` to its dispatch checks and model calls as
 * `CurrentPromptCacheKey` and `CurrentModelCallPolicy`, which the dispatch
 * check compares with the request's header, `CurrentEmptyResponseTolerance`
 * false to its model calls until the run has executed a tool call (a cut
 * reply's calls, answered unrun, are none) and true after, the current
 * step to its tool handlers and model calls as
 * `CurrentAgentStep`, its step events numbered alike), a request refused
 * over an image planned again and sent once more when `onMediaRejected`
 * answers true, failing the step when it answers false,
 * a streamed step's reasoning reaching the next request with its provider
 * metadata (Anthropic's signed and redacted thinking), as a non-streamed one's
 * does, and the ids of planned and id-less tool calls distinct across the runs
 * and turns of a session, with the request's run ordinal on every step event.
 */
export const stepLoopConformance = (loop: Context.Service.Shape<typeof StepLoop>): ReadonlyArray<ConformanceCheck> => [
  {
    name: "typed model failures fail once before tools, recording, corrections or stream fallback",
    run: Effect.gen(function* () {
      const check = "model-failures"
      const stamped = (reason: "length" | "tool-calls"): ReadonlyArray<Part> => probeCall("overflow-call", 1).map((part) => part.type === "finish"
        ? { ...part, reason, metadata: { engine: { failure: "ContextOverflow" } } } : part)
      const error = AiError.make({ module: "Conformance", method: "generateText", reason: new AiError.InvalidOutputError({ description: "protocol decode failed", metadata: { engine: { failure: "InvalidResponse" } } }) })
      yield* Effect.forEach([
        { scenario: { script: [stamped("length")] }, code: "model.context-overflow" },
        { scenario: { script: [stamped("tool-calls")] }, code: "model.context-overflow" },
        { scenario: { script: [stamped("length")], stream: [[{ type: "error", error: { detail: "opaque" }, metadata: { engine: { failure: "ContextOverflow" } } }]], streaming: true }, code: "model.context-overflow" },
        { scenario: { script: [], failure: error, streaming: true }, code: "model.invalid-response" },
      ] satisfies ReadonlyArray<{ readonly scenario: Scenario; readonly code: string }>, ({ scenario, code }) => Effect.gen(function* () {
        const observed = yield* observeRun(loop, scenario)
        yield* expect(check, failedWith(observed.result, code), `a semantic model failure ${endingOf(observed.result)}, expected ${code}`)
        yield* expect(check, observed.providerCalls.length === 1 && observed.records.length === 0 && observed.steps.handled.length === 0, "a semantic failure dispatched again, persisted a response, or ran a handler")
        yield* expect(check, statusesOf(observed.events).join() === "failed" && !observed.events.some((event) => event._tag === "stream.fallback" || event._tag === "completion.evaluated" || event._tag === "assistant.message"), "a semantic failure was corrected, completed or sent through stream fallback")
        if (scenario.failure !== undefined) {
          yield* expect(check, Result.isFailure(observed.result) && observed.result.failure._tag === "HarnessError" && observed.result.failure.cause === scenario.failure, "the typed model failure lost its original cause")
        }
      }), { concurrency: 1 })
    }),
  },
  {
    name: "honours custom degenerate-loop thresholds and explicit disabling without overriding the step cap",
    run: Effect.gen(function* () {
      const repeated = Array.from({ length: 8 }, (_, index) => probeCall(`repeat-${index}`, 1))
      const custom = yield* observe(loop, { script: repeated, maxSteps: 10, degenerate: { _tag: "Enabled", nudgeAfter: 1, breakAfter: 2 } })
      yield* expect("degenerate-policy", custom.result.reason === "degenerate-loop" && custom.result.steps === 3 && custom.providerCalls.length === 3,
        `custom thresholds ended ${custom.result.reason} after ${custom.result.steps} steps and ${custom.providerCalls.length} calls, not degenerate-loop after 3`)
      const nudges = custom.recorded.filter((entry) => entry.body._tag === "Message" && entry.body.message.role === "user")
      yield* expect("degenerate-policy", nudges.length === 1 && nudges[0]?.step === 2, "the custom nudge was not recorded exactly under the next step that read it")
      const disabled = yield* observe(loop, { script: [...repeated, textReply("finished")], maxSteps: 10, degenerate: { _tag: "Disabled" } })
      yield* expect("degenerate-policy", disabled.result.reason === "completed" && disabled.result.text === "finished" && disabled.providerCalls.length === 9,
        `a disabled breaker ended ${disabled.result.reason} after ${disabled.providerCalls.length} calls`)
      const capped = yield* observe(loop, { script: repeated, maxSteps: 2, degenerate: { _tag: "Enabled", nudgeAfter: 1, breakAfter: 2 } })
      yield* expect("degenerate-policy", capped.result.reason === "step-cap" && capped.recorded.every((entry) => entry.step < 2), "a cap left an unread nudge under a step that never started")
    }),
  },
  {
    name: "fails on the configured consecutive malformed response, with a cut or whole response resetting the streak",
    run: Effect.gen(function* () {
      const first = yield* observeRun(loop, { script: [malformedCall("m1"), textReply("must not run")], malformedLimit: 1 })
      yield* expect("malformed-limit", Result.isFailure(first.result) && first.providerCalls.length === 1 && first.recorded.length === 0,
        "a one-response malformed limit retried or recorded an unread corrective")
      const longer = yield* observe(loop, { script: [malformedCall("m1"), malformedCall("m2"), malformedCall("m3"), textReply("recovered")], malformedLimit: 4 })
      yield* expect("malformed-limit", longer.result.text === "recovered" && longer.providerCalls.length === 4, "a custom malformed cap retained the old three-response limit")
      const reset = yield* observe(loop, { script: [malformedCall("m1"), cutText("length", "prefix "), malformedCall("m2"), probeCall("p1", 7), malformedCall("m3"), textReply("done")], malformedLimit: 2, maxSteps: 8 })
      yield* expect("malformed-limit", reset.result.reason === "completed" && reset.providerCalls.length === 6, "a cut or whole response did not reset the malformed streak")
    }),
  },
  {
    name: "provides the exact request run to handlers and model calls as CurrentAgentRun, whatever the caller's and concurrent runs'",
    run: Effect.gen(function* () {
      const arrived = yield* Ref.make(0)
      const ready = yield* Deferred.make<void>()
      const timedOut = yield* Ref.make(false)
      const barrier = Ref.updateAndGet(arrived, (count) => count + 1).pipe(Effect.flatMap((count) => count >= 2
        ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
        : Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Ref.set(timedOut, true) }))))
      const caller = Option.some<RunRef>({ id: RunId.make("outer"), turn: 41, ordinal: RunOrdinal.make(19) })
      yield* Effect.forEach([0, 1], (ordinal) => Effect.gen(function* () {
        const run: RunRef = { id: RUN, turn: 2, ordinal: RunOrdinal.make(ordinal) }
        const observed = yield* observe(loop, { script: [probeCall("same-provider-id", 1), textReply("done")], run, ambientRun: caller, providerCall: barrier })
        const reads = [...observed.runs.handled, ...observed.runs.called]
        yield* expect("run-reference", !(yield* Ref.get(timedOut)) && reads.length === 3 && reads.every((read) => Option.isSome(read) && canonicalJson(read.value) === canonicalJson(run)),
          `run ${ordinal} handlers and model calls read ${canonicalJson(reads.map(Option.getOrNull))}, not their own exact request run`)
      }), { concurrency: 2 })
    }),
  },
  {
    name: "validates every real request immediately before dispatch, excluding planned batches",
    run: Effect.gen(function* () {
      const { dispatches, providerCalls } = yield* observe(loop, { initial: { calls: [{ name: Probe.name, params: { n: 2 } }], skills: [] }, script: [textReply("done")] })
      yield* expect("dispatch", dispatches.join() === "1" && providerCalls.length === 1, `dispatches ${dispatches.join()}, ${providerCalls.length} provider calls`)
    }),
  },
  {
    name: "a failed durable request check prevents the provider call",
    run: Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const result = yield* Effect.result(observe(loop, {
        script: [textReply("must not run")], providerCall: Ref.update(calls, (count) => count + 1),
        dispatch: () => Effect.fail(new HarnessError({ code: "request.diverged", message: "fixture request changed" })),
      }))
      yield* expect("dispatch", result._tag === "Failure" && (yield* Ref.get(calls)) === 0, "a rejected request reached the provider")
    }),
  },
  {
    name: "records the assistant response and publishes its usage before any handler runs, for settled, streamed and planned calls",
    run: Effect.gen(function* () {
      yield* Effect.forEach([
        { script: [probeCall("c1", 1), textReply("done")] },
        { streaming: true, script: [thinkingProbeCall("c1", 1), textReply("done")], stream: [streamedThinkingProbeCall("c1", 1), streamedText("done")] },
        { initial: { calls: [{ name: Probe.name, params: { n: 1 } }], skills: [] }, script: [textReply("done")] },
      ] satisfies ReadonlyArray<Scenario>, (scenario) => Effect.gen(function* () {
        const observed = yield* observe(loop, scenario)
        const before = observed.atHandlers[0] ?? []
        const calls = before.flatMap((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant"
          ? entry.body.message.content.filter((part) => part.type === "tool-call") : [])
        yield* expect("assistant-first", observed.atHandlers.length === 1 && calls.length === 1,
          "the handler began before its assistant tool call was recorded")
        const assistant = indexOf(observed.events, "assistant.message", 0)
        const started = indexOf(observed.events, "tool.started", 0)
        yield* expect("assistant-first", assistant >= 0 && started > assistant,
          "the handler began before the assistant usage event was published")
        const allCalls = observed.recorded.flatMap((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant"
          ? entry.body.message.content.filter((part) => part.type === "tool-call") : [])
        yield* expect("assistant-first", allCalls.length === 1, "the assistant tool call was recorded more than once")
      }), { concurrency: 1, discard: true })
      const provided = yield* observe(loop, {
        script: [[
          { type: "tool-call", id: "provided", name: Probe.name, params: { n: 9 }, providerExecuted: true },
          { type: "tool-result", id: "provided", name: Probe.name, result: 9, isFailure: false, providerExecuted: true },
          ...probeCall("c1", 1),
        ], textReply("done")],
      })
      const embedded = (provided.atHandlers[0] ?? []).flatMap((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant"
        ? entry.body.message.content.filter((part) => part.type === "tool-result" && part.providerExecuted && part.toolCallId === "provided") : [])
      yield* expect("assistant-first", embedded.length === 1 && embedded[0]?.type === "tool-result" && embedded[0].output === 9,
        "the provider's own result was not recorded in its assistant message before the local handler ran")
    }),
  },
  {
    name: "records each tool result as it returns while a sibling call is still held, in completion order",
    run: Effect.gen(function* () {
      const secondRecorded = yield* Deferred.make<void>()
      const firstSawSecond = yield* Ref.make(false)
      const batches = yield* Ref.make<ReadonlyArray<string>>([])
      const observed = yield* observe(loop, {
        script: [[...probeCall("c1", 1).slice(0, -1), ...probeCall("c2", 2)], textReply("done")],
        toolConcurrency: 2,
        handle: (n) => n !== 1 ? Effect.void : Deferred.await(secondRecorded).pipe(
          Effect.timeoutOption("1 second"), Effect.flatMap((done) => Ref.set(firstSawSecond, Option.isSome(done))),
        ),
        recorded: (_step, tail) => {
          const ids = tail.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.toolCallId)) : [])
          return Ref.update(batches, (all) => ids.length === 0 ? all : [...all, ids.join()]).pipe(
            Effect.andThen(ids.includes("c2") ? Deferred.succeed(secondRecorded, undefined).pipe(Effect.asVoid) : Effect.void),
          )
        },
      })
      const order = yield* Ref.get(batches)
      yield* expect("incremental-results", (yield* Ref.get(firstSawSecond)) && order.join("|") === "c2|c1",
        `result records were ${order.join("|")}; the held sibling ${(yield* Ref.get(firstSawSecond)) ? "saw" : "did not see"} its sibling's durable result`)
      const results = observed.recorded.filter((entry) => entry.body._tag === "ToolResult")
      yield* expect("incremental-results", results.length === 2, "a tool result was recorded more than once")
    }),
  },
  {
    name: "a failed assistant record prevents every handler, and a failed result record stops ordered calls; each step ends failed",
    run: Effect.forEach([false, true], (failResult) => Effect.gen(function* () {
      const observed = yield* observeRun(loop, {
        script: [[...probeCall("c1", 1).slice(0, -1), ...probeCall("c2", 2)]],
        recording: (_step, tail) => tail.some((message) => message.role === (failResult ? "tool" : "assistant"))
          ? Effect.fail(new HarnessError({ code: "conformance.record", message: "the durable record failed" })) : Effect.void,
      })
      const expected = failResult ? 1 : 0
      yield* expect("record-failure", failedWith(observed.result, "conformance.record") && observed.steps.handled.length === expected,
        `after a ${failResult ? "result" : "response"} record failed, ${observed.steps.handled.length} handlers ran (expected ${expected}) and the run ${endingOf(observed.result)}`)
      yield* expect("record-failure", statusesOf(observed.events).join() === "failed", "a step whose durable record failed did not end once as failed")
    }), { concurrency: 1, discard: true }),
  },
  {
    name: "a failed result presentation leaves its raw result listed on the failed step by durable entry id",
    run: Effect.gen(function* () {
      const observed = yield* observeRun(loop, {
        script: [probeCall("c1", 1)],
        recorded: (_step, tail) => tail.some((message) => message.role === "tool")
          ? Effect.fail(new HarnessError({ code: "conformance.presentation", message: "the result presentation failed after its raw commit" })) : Effect.void,
      })
      const result = observed.recorded.find((entry) => entry.body._tag === "ToolResult")
      const ended = observed.events.find((event) => event._tag === "step.ended")
      yield* expect("recorded-results", failedWith(observed.result, "conformance.presentation") && result?.body._tag === "ToolResult", "the fixture did not leave a durable raw result after its presentation failed")
      yield* expect("recorded-results", ended?._tag === "step.ended" && ended.status === "failed" && ended.results.length === 1
        && ended.results[0]?.entry === result?.id && ended.results[0]?.toolCallId === "c1" && ended.results[0]?.ok === true,
        "the failed step did not list its durable raw result with its entry id and successful outcome")
    }),
  },
  {
    name: "orders step.started < tool.* < step.ended < completion.evaluated within every step",
    run: Effect.gen(function* () {
      const check = "order"
      const { events } = yield* observe(loop, { script: [probeCall("c1", 1), textReply("done")] })
      yield* Effect.forEach([0, 1], (step) => Effect.gen(function* () {
        const started = indexOf(events, "step.started", step)
        const ended = indexOf(events, "step.ended", step)
        const evaluated = indexOf(events, "completion.evaluated", step)
        const toolEvents = events.flatMap((event, index) => (event._tag === "tool.started" || event._tag === "tool.completed") && event.step === step ? [index] : [])
        yield* expect(check, started >= 0 && ended > started && evaluated > ended, `step ${step}: started ${started}, ended ${ended}, evaluated ${evaluated}`)
        yield* expect(check, toolEvents.every((index) => index > started && index < ended), `step ${step}: tool events outside the step`)
      }), { concurrency: 1 })
      yield* expect(check, events.some((event) => event._tag === "tool.completed" && event.step === 0), "the probe call of step 0 was not published")
    }),
  },
  {
    name: "step.ended lists the step's recorded tool results by entry id",
    run: Effect.gen(function* () {
      const { events, recorded } = yield* observe(loop, { script: [probeCall("c1", 1), textReply("done")] })
      const ended = events.find((event) => event._tag === "step.ended" && event.step === 0)
      const results = ended?._tag === "step.ended" ? ended.results : []
      const expected = recorded.filter((entry) => entry.step === 0 && entry.body._tag === "ToolResult").map((entry) => String(entry.id))
      yield* expect("results", results.length === 1 && results.map((result) => String(result.entry)).join() === expected.join() && results[0]?.tool === Probe.name,
        `expected ${expected.join()}, got ${results.map((result) => result.entry).join()}`)
    }),
  },
  {
    name: "consumes durable steers before the first step plan, once per separate exact user message",
    run: Effect.gen(function* () {
      const message: AgentMessage = { role: "user", content: "the durable instruction before step zero" }
      const observed = yield* observe(loop, { script: [textReply("done")], replay: true, durableSteering: { at: "initial", messages: [message] } })
      const stored = observed.recorded.filter((entry) => entry.body._tag === "Message" && canonicalJson(entry.body.message) === canonicalJson(message))
      yield* expect("steering-first", observed.providerCalls.length === 1 && canonicalJson(observed.prompts[0]).includes("the durable instruction before step zero")
        && stored.length === 1 && observed.durable.pending.length === 0, "preexisting steering was missed, recorded twice or taken after the first plan")
      yield* expect("steering-first", observed.durable.taken.every((taken) => taken.after > indexOf(observed.events, "step.started", taken.step)), "a durable steer was recorded before its step started")
    }),
  },
  {
    name: "durable steers arriving with a final completion verdict force another step and retain separate messages and images",
    run: Effect.gen(function* () {
      const image = yield* mediaFromBase64(pixelPng).pipe(Effect.orDie)
      const messages: ReadonlyArray<AgentMessage> = [{ role: "user", content: "the first durable change" }, { role: "user", content: [image, { type: "text", text: "the second durable image change" }] }]
      const observed = yield* observe(loop, {
        script: [textReply("the old final reply"), textReply("the revised final reply")], replay: true,
        completion: () => Effect.succeed({ complete: true, awaiting: [], facts: {} }),
        durableSteering: { at: "completion", messages },
      })
      yield* expect("durable-steering", observed.providerCalls.length === 2 && observed.result.text === "the revised final reply" && observed.durable.pending.length === 0,
        "a true completion verdict skipped durable steering or did not complete the revised request")
      const second = canonicalJson(observed.prompts[1])
      yield* expect("durable-steering", second.includes("the first durable change") && second.includes("the second durable image change") && second.includes(pixelPng), "a durable steer's exact text or attachment was lost before dispatch")
      const taken = observed.recorded.filter((entry) => entry.body._tag === "Message" && messages.some((message) => canonicalJson(entry.body._tag === "Message" ? entry.body.message : {}) === canonicalJson(message)))
      yield* expect("durable-steering", taken.length === 2 && taken.every((entry) => entry.step === 1)
        && observed.durable.taken.every((point) => point.after > indexOf(observed.events, "step.started", point.step)), "steers were merged, duplicated or recorded outside their next started step")
    }),
  },
  {
    name: "pending durable steers at the step cap remain queued with nothing recorded under an unstarted step",
    run: Effect.forEach([
      { script: [textReply("final at the cap")] },
      { script: [malformedCall("cap-malformed")] },
      { script: [cutText("length", "cut at the cap")] },
      { script: [], initial: { calls: [{ name: Probe.name, params: { n: 1 } }], skills: [] } },
    ], (scenario) => Effect.gen(function* () {
      const message: AgentMessage = { role: "user", content: "leave this steer queued at the cap" }
      const observed = yield* observe(loop, { ...scenario, maxSteps: 1, durableSteering: { at: "settled", messages: [message] } })
      yield* expect("steering-cap", observed.result.outcome === "partial" && observed.result.reason === "step-cap" && observed.durable.pending.length === 1
        && observed.durable.taken.length === 0 && observed.recorded.every((entry) => entry.step === 0), "the cap consumed steering, completed unfinished input or recorded a nonexistent next step")
      yield* expect("steering-cap", observed.durable.probes > 0, "a settled final step never checked pending steering")
    }), { concurrency: 1, discard: true }),
  },
  {
    name: "steering enqueued after the final empty probe waits for the next turn without another provider call",
    run: Effect.gen(function* () {
      const message: AgentMessage = { role: "user", content: "arrived after the empty final probe" }
      const observed = yield* observe(loop, { script: [textReply("complete")], durableSteering: { at: "empty-probe", messages: [message] } })
      yield* expect("steering-empty-poll", observed.result.outcome === "completed" && observed.providerCalls.length === 1 && observed.durable.pending.length === 1
        && observed.durable.taken.length === 0, "the final probe was skipped or a later arrival was consumed after completion")
    }),
  },
  {
    name: "a failed durable steering commit prevents the provider request and leaves the input waiting",
    run: Effect.gen(function* () {
      const message: AgentMessage = { role: "user", content: "the steer whose commit is refused" }
      const observed = yield* observeRun(loop, {
        script: [textReply("must not be requested")], durableSteering: { at: "initial", messages: [message], failure: new HarnessError({ code: "conformance.steering", message: "the steering commit was refused" }) },
      })
      yield* expect("steering-error", failedWith(observed.result, "conformance.steering") && observed.providerCalls.length === 0 && observed.durable.pending.length === 1
        && observed.recorded.length === 0 && statusesOf(observed.events).join() === "failed", "a failed steer was lost, sent anyway or failed outside its started step")
    }),
  },
  {
    name: "ends each step once, and records nothing under a step after its step.ended (correctives, nudges and steers included)",
    run: Effect.gen(function* () {
      const check = "settled"
      // A malformed step, a reply cut at the output limit, a stop the host finds incomplete, steers, a tool call, then the reply.
      const { events, records } = yield* observe(loop, {
        script: [malformedCall("m1"), cutCalls("length", "cut"), textReply("not yet"), probeCall("c1", 1), textReply("done")],
        requireCompletion: true, steering: ["steer", "steer again"],
        completion: (step) => Effect.succeed({ complete: step >= 4, awaiting: [], facts: {} }),
      })
      const startedSteps = events.flatMap((event) => event._tag === "step.started" ? [event.step] : [])
      const endedSteps = events.flatMap((event) => event._tag === "step.ended" ? [event.step] : [])
      yield* expect(check, startedSteps.length > 1 && startedSteps.join() === endedSteps.join(),
        `the steps started ${startedSteps.join()} and ended ${endedSteps.join()}`)
      const late = records.filter((record) => {
        const ended = indexOf(events, "step.ended", record.step)
        return ended >= 0 && ended < record.after
      })
      yield* expect(check, late.length === 0,
        `recorded under step ${late.map((record) => record.step).join(", ")} after that step's step.ended`)
    }),
  },
  {
    name: "records nothing under a step that never starts (the step cap or a complete verdict ends the run first)",
    run: Effect.forEach([
      // The cap ends a run the host still finds incomplete, and one whose last step was malformed.
      { maxSteps: 2, requireCompletion: true, script: [textReply("not yet"), textReply("still not")] },
      { maxSteps: 2, script: [probeCall("c1", 1), malformedCall("m1")] },
      // The cap ends a run at a reply cut at the output limit, of text alone and with calls: no corrective follows it.
      { maxSteps: 1, script: [cutText("length", "The answer is ")] },
      { maxSteps: 1, script: [cutCalls("length", "cut")] },
      // A complete verdict ends a run that repeats the same call.
      { script: [probeCall("c1", 1), probeCall("c2", 1), probeCall("c3", 1), probeCall("c4", 1)], completion: (step: number) => Effect.succeed({ complete: step >= 3, awaiting: [], facts: {} }) },
    ] satisfies ReadonlyArray<Scenario>, (scenario) => Effect.gen(function* () {
      const { events, recorded } = yield* observe(loop, scenario)
      const startedSteps = events.flatMap((event) => event._tag === "step.started" ? [event.step] : [])
      const stray = recorded.filter((entry) => !startedSteps.includes(entry.step))
      yield* expect("unstarted", stray.length === 0,
        `recorded under step ${[...new Set(stray.map((entry) => entry.step))].join(", ")}, which never started (the steps started ${startedSteps.join()})`)
    }), { concurrency: 1, discard: true }),
  },
  {
    name: "a completion that fails after a completed step fails the run and leaves that step completed",
    run: Effect.gen(function* () {
      const { events, result } = yield* observeRun(loop, {
        script: [probeCall("c1", 1), textReply("done")],
        completion: () => Effect.fail(new HarnessError({ code: "conformance.completion", message: "the completion policy failed" })),
      })
      const ends = events.flatMap((event) => event._tag === "step.ended" && event.step === 0 ? [event.status] : [])
      yield* expect("settled", result._tag === "Failure" && ends.join() === "completed",
        `the run's ${result._tag}; step 0 ended ${JSON.stringify(ends)}`)
    }),
  },
  {
    name: "a malformed step ends malformed, with no completion.evaluated, and the run goes on",
    run: Effect.gen(function* () {
      const { events, result } = yield* observe(loop, { script: [malformedCall("m1"), textReply("done")] })
      const endsOf = (step: number) => events.flatMap((event) => event._tag === "step.ended" && event.step === step ? [event.status] : [])
      yield* expect("malformed", endsOf(0).join() === "malformed" && endsOf(1).join() === "completed",
        `step 0 ended ${JSON.stringify(endsOf(0))}, step 1 ${JSON.stringify(endsOf(1))}`)
      yield* expect("malformed", indexOf(events, "completion.evaluated", 0) < 0 && result.outcome === "completed" && result.text === "done",
        `the malformed step's completion was ${indexOf(events, "completion.evaluated", 0) < 0 ? "not " : ""}evaluated; the run ${result.outcome} with ${JSON.stringify(result.text)}`)
    }),
  },
  {
    name: "a reply cut at the output limit runs none of its tool calls, answers each as cut, ends its step truncated and is answered with a corrective",
    run: observe(loop, { replay: true, script: [cutCalls("length", "cut"), textReply("done")] }).pipe(Effect.flatMap((observed) => expectCut("cut", observed))),
  },
  {
    name: "a streamed reply cut at the output limit runs none of its tool calls, not even one that arrived before the next",
    run: observe(loop, {
      replay: true, streaming: true,
      script: [cutCalls("length", "cut"), textReply("done")],
      stream: [streamedCutCalls("length", "cut"), streamedText("done")],
    }).pipe(Effect.flatMap((observed) => expectCut("cut-stream", observed))),
  },
  {
    name: "a reply cut short but at the output limit (content-filter, error, other) fails the run with loop.truncated, and so does a third reply in a row cut at the output limit, after two correctives",
    run: Effect.gen(function* () {
      const check = "cut-fail"
      yield* Effect.forEach(UNCORRECTED_CUTS, (reason) => Effect.gen(function* () {
        const cut = yield* observeRun(loop, { script: [cutCalls(reason, "cut"), textReply("done")] })
        yield* expect(check, failedWith(cut.result, "loop.truncated") && cut.providerCalls.length === 1,
          `after a reply cut short (${reason}), the run ${endingOf(cut.result)} after ${cut.providerCalls.length} provider calls, not failed with loop.truncated after 1`)
        yield* expect(check, statusesOf(cut.events).join() === "truncated" && cut.steps.handled.length === 0 && indexOf(cut.events, "completion.evaluated", 0) < 0,
          `after a reply cut short (${reason}), the steps ended ${JSON.stringify(statusesOf(cut.events))} (not [truncated]), ${cut.steps.handled.length} probe handler calls ran, and the cut step's completion was ${indexOf(cut.events, "completion.evaluated", 0) < 0 ? "not " : ""}evaluated`)
        // A reply of text alone cut short is cut as well: its text is not the run's answer.
        const cutAlone = yield* observeRun(loop, { script: [cutText(reason, "The answer is "), textReply("done")] })
        yield* expect(check, failedWith(cutAlone.result, "loop.truncated") && cutAlone.providerCalls.length === 1
          && statusesOf(cutAlone.events).join() === "truncated" && indexOf(cutAlone.events, "completion.evaluated", 0) < 0,
          `after a reply of text alone cut short (${reason}), the run ${endingOf(cutAlone.result)} after ${cutAlone.providerCalls.length} provider calls, its steps ended ${JSON.stringify(statusesOf(cutAlone.events))} and the cut step's completion was ${indexOf(cutAlone.events, "completion.evaluated", 0) < 0 ? "not " : ""}evaluated, not failed with loop.truncated after 1 truncated step`)
      }), { concurrency: 1, discard: true })
      const thrice = yield* observeRun(loop, { script: [cutCalls("length", "a"), cutCalls("length", "b"), cutCalls("length", "c"), textReply("done")] })
      const correctives = thrice.recorded.flatMap((entry) => entry.body._tag === "Message" && entry.body.message.role === "user" ? [entry.step] : [])
      yield* expect(check, failedWith(thrice.result, "loop.truncated") && thrice.providerCalls.length === 3,
        `after three replies in a row cut at the output limit, the run ${endingOf(thrice.result)} after ${thrice.providerCalls.length} provider calls, not failed with loop.truncated after 3`)
      yield* expect(check, statusesOf(thrice.events).join() === "truncated,truncated,truncated" && thrice.steps.handled.length === 0 && correctives.join() === "1,2",
        `the steps ended ${JSON.stringify(statusesOf(thrice.events))}, ${thrice.steps.handled.length} probe handler calls ran, and the loop's correctives were recorded under the steps ${JSON.stringify(correctives)}, not [1,2]`)
    }),
  },
  {
    name: "a malformed or a whole step between replies cut at the output limit restarts their count in a row, and a cut step restarts the count of malformed steps in a row",
    run: Effect.forEach([
      // Two cuts, a step that is no cut, then a third: the count restarted, so it is answered with a corrective too.
      { between: "a malformed step between replies cut at the output limit", script: [cutCalls("length", "a"), cutCalls("length", "b"), malformedCall("m1"), cutCalls("length", "c"), textReply("done")], ends: "truncated,truncated,malformed,truncated,completed" },
      { between: "a probe call between replies cut at the output limit", script: [cutCalls("length", "a"), cutCalls("length", "b"), probeCall("p1", 1), cutCalls("length", "c"), textReply("done")], ends: "truncated,truncated,completed,truncated,completed" },
      // Three malformed steps, a cut after the first: no more than two of them in a row.
      { between: "a reply cut at the output limit between malformed steps", script: [malformedCall("m1"), cutCalls("length", "a"), malformedCall("m2"), malformedCall("m3"), textReply("done")], ends: "malformed,truncated,malformed,malformed,completed" },
    ], ({ between, script, ends }) => Effect.gen(function* () {
      const { events, providerCalls, result } = yield* observeRun(loop, { script })
      yield* expect("cut-reset", Result.isSuccess(result) && result.success.outcome === "completed" && result.success.text === "done"
        && providerCalls.length === script.length && statusesOf(events).join() === ends,
        `with ${between}, the run ${endingOf(result)} after ${providerCalls.length} provider calls, its steps ended ${JSON.stringify(statusesOf(events))}, `
        + `not completed with "done" after ${script.length}, its steps ended [${ends}]`)
    }), { concurrency: 1, discard: true }),
  },
  {
    name: "a reply of text alone cut at the output limit ends its step truncated and is answered with a corrective to go on from it, and the run's text is that reply's followed by the next one's",
    run: Effect.gen(function* () {
      const check = "cut-text"
      const { events, prompts, recorded, result } = yield* observe(loop, { replay: true, script: [cutText("length", "The answer is "), textReply("forty-two.")] })
      yield* expect(check, statusesOf(events).join() === "truncated,completed" && indexOf(events, "completion.evaluated", 0) < 0,
        `the steps ended ${JSON.stringify(statusesOf(events))} (not [truncated,completed]), and the cut step's completion was ${indexOf(events, "completion.evaluated", 0) < 0 ? "not " : ""}evaluated`)
      yield* expect(check, finishReasonsOf(events).join() === "length,stop",
        `the assistant messages carried the finish reasons ${JSON.stringify(finishReasonsOf(events))}, not [length,stop]`)
      /** The user messages the loop recorded under step 1 of a run: its corrective after the cut reply. */
      const correctivesOf = (entries: ReadonlyArray<LogEntry>) => entries.flatMap((entry) =>
        entry.step === 1 && entry.body._tag === "Message" && entry.body.message.role === "user" ? [canonicalJson(entry.body.message.content)] : [])
      const next = prompts[1]?.content ?? []
      const cutAt = next.findIndex((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === "The answer is "))
      const correctiveAt = next.findLastIndex((message) => message.role === "user")
      const corrective = correctivesOf(recorded)
      // The corrective after a reply cut with calls in it, which says to call them again: there were none.
      const called = correctivesOf((yield* observe(loop, { replay: true, script: [cutCalls("length", "cut"), textReply("done")] })).recorded)
      yield* expect(check, prompts.length === 2 && cutAt >= 0 && correctiveAt > cutAt && corrective.length === 1 && called.length === 1 && corrective[0] !== called[0],
        `the request after the cut reply held ${JSON.stringify(next.map((message) => message.role))} (the cut reply at ${cutAt}, the last user message at ${correctiveAt}), with ${JSON.stringify(corrective)} recorded under step 1, `
        + `not a corrective after the cut reply other than the one after a cut reply's calls (${JSON.stringify(called)})`)
      yield* expect(check, result.outcome === "completed" && result.text === "The answer is forty-two.",
        `the run ended ${result.outcome} with ${JSON.stringify(result.text)}, not completed with "The answer is forty-two."`)
      // The step cap ends the run at the cut reply: its text is the run's.
      const capped = (yield* observe(loop, { maxSteps: 1, script: [cutText("length", "The answer is ")] })).result
      yield* expect(check, capped.outcome === "partial" && capped.reason === "step-cap" && capped.text === "The answer is ",
        `with one step, the run ended ${capped.outcome}/${capped.reason} with ${JSON.stringify(capped.text)} after the cut reply, not partial/step-cap with "The answer is "`)
      // A reply cut at the output limit with calls in it is replied to anew: its text is not carried into the next reply's.
      const withCalls = (yield* observe(loop, { script: [afterText("Let me check. ", cutCalls("length", "cut")), textReply("done")] })).result
      yield* expect(check, withCalls.outcome === "completed" && withCalls.text === "done",
        `after a reply of text and calls cut at the output limit, the run ended ${withCalls.outcome} with ${JSON.stringify(withCalls.text)}, not completed with the next reply's "done" alone`)
    }),
  },
  {
    name: "a reply calling a tool with no finish reason from the provider runs none of its calls, ends its step truncated and fails the run with loop.truncated; a text reply without one completes the run",
    run: Effect.gen(function* () {
      const check = "cut-unknown"
      yield* Effect.forEach([
        { form: "with no finish part", reply: unfinished(probeCall("u1", 1)) },
        { form: "whose finish says unknown", reply: finishedUnknown(probeCall("u1", 1)) },
      ], ({ form, reply }) => Effect.gen(function* () {
        const { events, providerCalls, result, steps } = yield* observeRun(loop, { script: [reply, textReply("done")] })
        const toolEvents = events.filter((event) => event._tag === "tool.started" || event._tag === "tool.completed").length
        yield* expect(check, steps.handled.length === 0 && toolEvents === 0 && statusesOf(events).join() === "truncated" && indexOf(events, "completion.evaluated", 0) < 0,
          `after a reply calling probe ${form}, ${steps.handled.length} probe handler calls ran, ${toolEvents} tool events were published, the steps ended ${JSON.stringify(statusesOf(events))} (not [truncated]), and the cut step's completion was ${indexOf(events, "completion.evaluated", 0) < 0 ? "not " : ""}evaluated`)
        yield* expect(check, failedWith(result, "loop.truncated") && providerCalls.length === 1 && finishReasonsOf(events).join() === "unknown",
          `after a reply calling probe ${form}, the run ${endingOf(result)} after ${providerCalls.length} provider calls, its assistant messages carrying ${JSON.stringify(finishReasonsOf(events))}, not failed with loop.truncated after 1, carrying [unknown]`)
      }), { concurrency: 1, discard: true })
      yield* Effect.forEach([
        { form: "a text reply with no finish part", script: [unfinished(textReply("all done"))], text: "all done", ends: "completed" },
        { form: "a text reply whose finish says unknown", script: [finishedUnknown(textReply("all done"))], text: "all done", ends: "completed" },
        // A call the provider ran itself is no call for the loop to run.
        { form: "a reply of text and a provider-executed call with no finish part", script: [providerExecutedReply("all done")], text: "all done", ends: "completed" },
        // The empty reply that says a run of tool calls is done.
        { form: "an empty reply after a probe call", script: [probeCall("c1", 1), []], text: "", ends: "completed,completed" },
      ], ({ form, script, text, ends }) => Effect.gen(function* () {
        const { events, result } = yield* observeRun(loop, { script })
        yield* expect(check, Result.isSuccess(result) && result.success.outcome === "completed" && result.success.text === text && statusesOf(events).join() === ends,
          `after ${form}, the run ${endingOf(result)} and its steps ended ${JSON.stringify(statusesOf(events))}, not completed with ${JSON.stringify(text)}, its steps ended [${ends}]`)
      }), { concurrency: 1, discard: true })
    }),
  },
  {
    name: "a reply the provider paused does not end the run: its step completes, the next one runs, and the run's text is the paused reply's followed by the next one's",
    run: Effect.gen(function* () {
      const { events, providerCalls, result } = yield* observe(loop, { script: [pausedReply("Part one, "), textReply("part two.")] })
      const started = events.flatMap((event) => event._tag === "step.started" ? [event.step] : [])
      yield* expect("pause", started.join() === "0,1" && statusesOf(events).join() === "completed,completed" && providerCalls.length === 2 && result.outcome === "completed" && result.text === "Part one, part two.",
        `after a paused reply, the steps started ${JSON.stringify(started)} and ended ${JSON.stringify(statusesOf(events))} after ${providerCalls.length} provider calls; the run ended ${result.outcome} with ${JSON.stringify(result.text)}, not "Part one, part two."`)
    }),
  },
  {
    name: "every assistant.message carries its response's finish reason",
    run: Effect.gen(function* () {
      const { events } = yield* observe(loop, { script: [probeCall("c1", 1), textReply("done")] })
      yield* expect("finish", finishReasonsOf(events).join() === "tool-calls,stop",
        `a probe call and a text reply published the finish reasons ${JSON.stringify(finishReasonsOf(events))}, not [tool-calls,stop]`)
    }),
  },
  {
    name: "a planned first batch runs without a provider call",
    run: Effect.gen(function* () {
      const { events, providerCalls } = yield* observe(loop, { initial: { calls: [{ name: Probe.name, params: { n: 2 } }], skills: [] }, script: [textReply("done")] })
      const first = events.find((event) => event._tag === "step.started" && event.step === 0)
      yield* expect("planned", first?._tag === "step.started" && first.planned, "step 0 is not marked planned")
      yield* expect("planned", events.some((event) => event._tag === "tool.completed" && event.step === 0), "the planned call did not run in step 0")
      yield* expect("planned", providerCalls.length === 1, `expected 1 provider call, got ${providerCalls.length}`)
    }),
  },
  {
    name: "a forced tool choice reaches the provider",
    run: Effect.gen(function* () {
      const { providerCalls } = yield* observe(loop, { toolChoice: { tool: Probe.name }, script: [textReply("done")] })
      const choice = providerCalls[0]
      yield* expect("tool-choice", typeof choice === "object" && choice !== null && "tool" in choice && choice.tool === Probe.name, `the provider saw ${JSON.stringify(choice)}`)
    }),
  },
  {
    name: "an awaiting verdict joins its tasks and is evaluated once more",
    run: Effect.gen(function* () {
      const done = yield* Ref.make(false)
      const { events, providerCalls, result } = yield* observe(loop, {
        script: [probeCall("c1", 1)],
        before: (tasks) => tasks.fork("work", Effect.sleep("20 millis").pipe(Effect.andThen(Ref.set(done, true)))),
        completion: () => Ref.get(done).pipe(Effect.map((complete): CompletionVerdict => ({ complete, awaiting: complete ? [] : ["work"], facts: {} }))),
      })
      const verdicts = events.flatMap((event) => event._tag === "completion.evaluated" && event.step === 0 ? [event.verdict] : [])
      yield* expect("awaiting", verdicts.length === 2 && verdicts[0]?.complete === false && verdicts[1]?.complete === true, `step 0 verdicts: ${JSON.stringify(verdicts)}`)
      yield* expect("awaiting", providerCalls.length === 1 && result.outcome === "completed", `${providerCalls.length} provider calls, ${result.outcome}`)
    }),
  },
  {
    name: "no provider call follows a complete verdict",
    run: Effect.gen(function* () {
      const { providerCalls, result } = yield* observe(loop, {
        script: [probeCall("c1", 1), probeCall("c2", 2)],
        completion: () => Effect.succeed({ complete: true, awaiting: [], facts: {} }),
      })
      yield* expect("complete", providerCalls.length === 1 && result.outcome === "completed", `${providerCalls.length} provider calls, ${result.outcome}`)
    }),
  },
  {
    name: "RunResult.usage is the sum of the run's assistant.message usage, cache writes and reasoning included",
    run: Effect.gen(function* () {
      const { events, result } = yield* observe(loop, { script: [withUsage(probeCall("c1", 1), billed(100, 10)), withUsage(textReply("done"), billed(140, 20))] })
      const published = events.flatMap((event) => event._tag === "assistant.message" ? [event.usage] : [])
      const total = sumUsage(published)
      yield* expect("usage", published.length === 2 && sameUsage(result.usage, total), `the run reported ${JSON.stringify(result.usage)}, its ${published.length} assistant messages ${JSON.stringify(total)}`)
      yield* expect("usage", total.inputTokens === 240 && total.cacheReadTokens === 40 && total.cacheWriteTokens === 20 && total.outputTokens === 30 && total.reasoningTokens === 6 && total.totalTokens === 270,
        `the assistant messages did not carry the provider's usage: ${JSON.stringify(total)}`)
    }),
  },
  {
    name: "provides the request's captureTraceContent to its model calls as CurrentTraceContent, whatever the caller's",
    run: Effect.gen(function* () {
      const script = [probeCall("c1", 1), textReply("done")]
      const on = yield* observe(loop, { script, captureTraceContent: true, ambientTraceContent: false })
      const off = yield* observe(loop, { script, captureTraceContent: false, ambientTraceContent: true })
      yield* expect("trace-content", on.traceContent.length === 2 && on.traceContent.every((capture) => capture),
        `with captureTraceContent on under a caller's off, the model calls read ${JSON.stringify(on.traceContent)}`)
      yield* expect("trace-content", off.traceContent.length === 2 && off.traceContent.every((capture) => !capture),
        `with captureTraceContent off under a caller's on, the model calls read ${JSON.stringify(off.traceContent)}`)
    }),
  },
  {
    name: "provides the request's cacheKey to its dispatch checks and model calls as CurrentPromptCacheKey, whatever the caller's",
    run: Effect.gen(function* () {
      const key = Option.some("conformance:cache-key")
      const { cacheKeys } = yield* observe(loop, { script: [probeCall("c1", 1), textReply("done")], cacheKey: key, ambientCacheKey: Option.some("conformance:caller") })
      const all = [...cacheKeys.dispatched, ...cacheKeys.called]
      yield* expect("cache-key", cacheKeys.dispatched.length === 2 && cacheKeys.called.length === 2 && all.every((read) => Option.getOrNull(read) === "conformance:cache-key"),
        `with the request's cacheKey ${Option.getOrNull(key)}, the dispatch checks read ${JSON.stringify(cacheKeys.dispatched.map(Option.getOrNull))} and the model calls ${JSON.stringify(cacheKeys.called.map(Option.getOrNull))}`)
    }),
  },
  {
    name: "provides the request's callPolicy to its dispatch checks and model calls as CurrentModelCallPolicy, whatever the caller's",
    run: Effect.gen(function* () {
      const script = [probeCall("c1", 1), textReply("done")]
      const caller = Option.some<ModelCallPolicy>({ effort: "low" })
      yield* Effect.forEach([Option.some<ModelCallPolicy>({ effort: "high", maxOutputTokens: 64 }), Option.none<ModelCallPolicy>()], (policy) => Effect.gen(function* () {
        const { callPolicies } = yield* observe(loop, { script, callPolicy: policy, ambientCallPolicy: caller })
        const json = (read: Option.Option<ModelCallPolicy>) => canonicalJson(Option.getOrNull(read))
        yield* expect("call-policy", callPolicies.dispatched.length === 2 && callPolicies.called.length === 2
          && [...callPolicies.dispatched, ...callPolicies.called].every((read) => json(read) === json(policy)),
          `with the request's callPolicy ${json(policy)} under a caller's ${json(caller)}, the dispatch checks read ${JSON.stringify(callPolicies.dispatched.map(Option.getOrNull))} and the model calls ${JSON.stringify(callPolicies.called.map(Option.getOrNull))}`)
      }), { concurrency: 1 })
    }),
  },
  {
    name: "provides CurrentEmptyResponseTolerance to its model calls: false until the run has executed a tool call, true after, whatever the caller's",
    run: Effect.gen(function* () {
      // A malformed step executes no tool call, nor does a reply cut short, its calls answered unrun; the probe's step does, and so does a planned batch.
      const { tolerance } = yield* observe(loop, { script: [malformedCall("m1"), cutCalls("length", "cut"), probeCall("c1", 1), textReply("done")], ambientTolerance: true })
      yield* expect("tolerance", tolerance.join() === "false,false,false,true",
        `under a caller's tolerance, a malformed step, a reply with calls cut at the output limit, a probe call and a reply read ${JSON.stringify(tolerance)}, not [false,false,false,true]`)
      const planned = yield* observe(loop, { initial: { calls: [{ name: Probe.name, params: { n: 0 } }], skills: [] }, script: [textReply("done")] })
      yield* expect("tolerance", planned.tolerance.join() === "true",
        `the reply after a planned batch read ${JSON.stringify(planned.tolerance)}, not [true]`)
    }),
  },
  {
    name: "provides the current step to its tool handlers and model calls as CurrentAgentStep, its step events numbered alike, whatever the caller's",
    run: Effect.gen(function* () {
      // A planned batch as step 0, then a probe call and a reply, under an outer run's step.
      const { events, steps } = yield* observe(loop, {
        initial: { calls: [{ name: Probe.name, params: { n: 0 } }], skills: [] }, script: [probeCall("c1", 1), textReply("done")],
        ambientStep: Option.some(41),
      })
      const [handled, called] = [steps.handled.map(Option.getOrNull), steps.called.map(Option.getOrNull)]
      yield* expect("step", handled.join() === "0,1" && called.join() === "1,2",
        `under a caller's step 41, the handlers read the steps ${JSON.stringify(handled)} (not [0,1]) and the model calls ${JSON.stringify(called)} (not [1,2])`)
      const started = events.flatMap((event) => event._tag === "step.started" ? [event.step] : [])
      yield* expect("step", started.join() === "0,1,2", `under a caller's step 41, the steps started were ${JSON.stringify(started)}, not [0,1,2]`)
    }),
  },
  {
    name: "a request refused over an image is planned again and sent once more when onMediaRejected answers true",
    run: Effect.gen(function* () {
      const reasons = yield* Ref.make<ReadonlyArray<string>>([])
      const plans = yield* Ref.make<ReadonlyArray<number>>([])
      const { dispatches, providerCalls, result } = yield* observe(loop, {
        script: [], refuseFirst: true,
        onMediaRejected: (reason) => Ref.update(reasons, (all) => [...all, reason]).pipe(Effect.as(true)),
        planned: (step) => Ref.update(plans, (all) => [...all, step]),
      })
      const asked = yield* Ref.get(reasons)
      const planned = (yield* Ref.get(plans)).filter((step) => step === 0).length
      yield* expect("media-rejected", asked.length === 1 && asked.every((reason) => /image/i.test(reason)), `onMediaRejected was asked ${JSON.stringify(asked)}`)
      yield* expect("media-rejected", planned === 2, `step 0 was planned ${planned} times, not twice`)
      yield* expect("media-rejected", dispatches.join() === "0,0" && providerCalls.length === 2 && result.outcome === "completed",
        `dispatches ${dispatches.join()}, ${providerCalls.length} provider calls, ${result.outcome}`)
    }),
  },
  {
    name: "a request refused over an image fails the step when onMediaRejected answers false",
    run: Effect.gen(function* () {
      const asked = yield* Ref.make(0)
      const calls = yield* Ref.make(0)
      const result = yield* Effect.result(observe(loop, {
        script: [], refuseFirst: true, providerCall: Ref.update(calls, (count) => count + 1),
        onMediaRejected: () => Ref.update(asked, (count) => count + 1).pipe(Effect.as(false)),
      }))
      const [rejections, sent] = [yield* Ref.get(asked), yield* Ref.get(calls)]
      yield* expect("media-rejected", result._tag === "Failure" && rejections === 1 && sent === 1,
        `${result._tag} after ${sent} provider calls, onMediaRejected asked ${rejections} times`)
    }),
  },
  {
    name: "a streamed reasoning part reaches the next request with its provider metadata",
    run: Effect.gen(function* () {
      const { prompts } = yield* observe(loop, {
        streaming: true, replay: true,
        script: [thinkingProbeCall("c1", 1), textReply("done")],
        stream: [streamedThinkingProbeCall("c1", 1), streamedText("done")],
      })
      const replayed = (prompts[1]?.content ?? []).flatMap((message) => message.role === "assistant" ? message.content : [])
        .flatMap((part) => part.type === "reasoning" ? [{ text: part.text, options: part.options }] : [])
      const expected = [{ text: "think", options: signed }, { text: "", options: redacted }]
      yield* expect("stream-metadata", prompts.length === 2 && canonicalJson(replayed) === canonicalJson(expected),
        `${prompts.length} provider calls; the second request's reasoning was ${JSON.stringify(replayed)}, not ${JSON.stringify(expected)}`)
    }),
  },
  {
    name: "id-less tool calls get ids distinct across two runs of a turn and two turns, and the step events carry the run",
    run: Effect.gen(function* () {
      const runs: ReadonlyArray<RunRef> = [FIRST_RUN, { ...FIRST_RUN, ordinal: RunOrdinal.make(1) }, { id: RunId.make("conformance-2"), turn: 2, ordinal: RunOrdinal.make(0) }]
      // A planned call, then a provider's call without an id, in each run.
      const observed = yield* Effect.forEach(runs, (run) => observe(loop, {
        run, initial: { calls: [{ name: Probe.name, params: { n: 1 } }], skills: [] }, script: [probeCall("", 2), textReply("done")],
      }), { concurrency: 1 })
      const ids = observed.flatMap(({ recorded }) => recorded.flatMap((entry) => entry.body._tag === "ToolResult" ? [String(entry.body.toolCallId)] : []))
      yield* expect("run-ids", ids.length === 6 && ids.every((id) => id.length > 0) && new Set(ids).size === ids.length,
        `the planned and id-less calls of two runs of a turn and of another turn were given the ids ${ids.join(", ")}`)
      const marked = observed.flatMap(({ events }, index) => events.flatMap((event) => "run" in event ? [{ tag: event._tag, run: event.run, expected: runs[index]?.ordinal }] : []))
      const stray = marked.filter((event) => event.run !== event.expected)
      yield* expect("run-events", stray.length === 0 && ["step.started", "step.ended", "assistant.message", "completion.evaluated"].every((tag) => marked.some((event) => event.tag === tag)),
        stray.length === 0 ? `the step events published were ${[...new Set(marked.map((event) => event.tag))].join(", ")}` : `${stray.map((event) => `${event.tag} carried run ${event.run}, not ${event.expected}`).join("; ")}`)
    }),
  },
  {
    name: "the step cap ends the run as partial",
    run: Effect.gen(function* () {
      const { providerCalls, result } = yield* observe(loop, { maxSteps: 2, script: [probeCall("c1", 1), probeCall("c2", 2), probeCall("c3", 3)] })
      yield* expect("step-cap", result.outcome === "partial" && result.reason === "step-cap" && providerCalls.length === 2,
        `${result.outcome}/${result.reason} after ${providerCalls.length} provider calls`)
    }),
  },
]
