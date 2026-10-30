import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Context, Effect, Option, Ref, Result, Schema, Stream } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { sameUsage } from "../conformance.functions.js"
import { Failure } from "../domain/failure.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import type { RunRef } from "../domain/run.entity.js"
import { sumUsage } from "../domain/token-usage.entity.functions.js"
import { CurrentPromptCacheKey } from "../loop/cacheKey.js"
import { CurrentAgentStep } from "../loop/stepContext.js"
import { CurrentTraceContent } from "../loop/traceContent.js"
import { canonicalJson, entryId } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { InitialBatch, ToolChoice } from "../ports/capability.port.js"
import type { RunResult, StepLoop, StepRequest } from "../ports/step-loop.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import type { TurnTasksService } from "../ports/turn-events.port.js"
import type { TurnError } from "../session/sessions.entity.js"
import { makeTurnEvents, makeTurnTasks } from "./turn-bus.js"
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
/** A scripted provider reply calling `probe`. */
export const probeCall = (id: string, n: number): ReadonlyArray<Part> => [
  { type: "tool-call", id, name: Probe.name, params: { n }, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]
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

/** A provider's usage with every count: cache reads and writes inside the input, reasoning inside the output. */
const billed = (input: number, output: number) => ({
  inputTokens: { total: input, uncached: input - 30, cacheRead: 20, cacheWrite: 10 },
  outputTokens: { total: output, text: output - 3, reasoning: 3 },
})
/** The same reply with another usage on its finish part. */
const withUsage = (reply: ReadonlyArray<Part>, value: ReturnType<typeof billed>): ReadonlyArray<Part> =>
  reply.map((part) => part.type === "finish" ? { ...part, usage: value } : part)

interface Scenario {
  readonly script: ReadonlyArray<ReadonlyArray<Part>>
  readonly initial?: InitialBatch
  readonly toolChoice?: ToolChoice
  readonly maxSteps?: number
  readonly completion?: (step: number, tasks: TurnTasksService) => Effect.Effect<CompletionVerdict, HarnessError>
  readonly before?: (tasks: TurnTasksService) => Effect.Effect<void>
  readonly dispatch?: (step: number) => Effect.Effect<void, HarnessError>
  readonly providerCall?: Effect.Effect<void>
  /** The request's `captureTraceContent` (off by default). */
  readonly captureTraceContent?: boolean
  /** `CurrentTraceContent` where the loop runs (off by default). */
  readonly ambientTraceContent?: boolean
  /** The request's `cacheKey` (none by default). */
  readonly cacheKey?: Option.Option<string>
  /** The provider refuses its first request over an image (an `InvalidRequestError` naming one). */
  readonly refuseFirst?: boolean
  /** The request's `onMediaRejected` (answers false by default). */
  readonly onMediaRejected?: (reason: string) => Effect.Effect<boolean>
  /** Runs on every `plan` call, with the step it plans. */
  readonly planned?: (step: number) => Effect.Effect<void>
  /** The request's `limits.streaming` (off by default). */
  readonly streaming?: boolean
  /** What the provider streams for each call, the streamed twin of `script`; without it, the provider does not stream. */
  readonly stream?: ReadonlyArray<ReadonlyArray<StreamPart>>
  /** Each plan holds the messages recorded so far after the user's, as a memory renders them (only the user's by default). */
  readonly replay?: boolean
  /** The request's `run` (`FIRST_RUN` by default). */
  readonly run?: RunRef
  /** What the request's `steering` answers, one text per consult, then none (none by default). */
  readonly steering?: ReadonlyArray<string>
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
  readonly dispatches: ReadonlyArray<number>
  /** `CurrentTraceContent` as each provider call read it. */
  readonly traceContent: ReadonlyArray<boolean>
  /** `CurrentPromptCacheKey` as each dispatch check, then each provider call, read it. */
  readonly cacheKeys: { readonly dispatched: ReadonlyArray<Option.Option<string>>; readonly called: ReadonlyArray<Option.Option<string>> }
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
  yield* events.subscribe(Option.some, (event: TurnEvent) => Ref.update(seen, (all) => [...all, event]))
  const calls = yield* Ref.make<ReadonlyArray<unknown>>([])
  const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
  const dispatches = yield* Ref.make<ReadonlyArray<number>>([])
  const traceContent = yield* Ref.make<ReadonlyArray<boolean>>([])
  const dispatchedKeys = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
  const calledKeys = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
  const readKey = (into: Ref.Ref<ReadonlyArray<Option.Option<string>>>) =>
    Effect.service(CurrentPromptCacheKey).pipe(Effect.flatMap((key) => Ref.update(into, (all) => [...all, key])))
  /** One provider call, streamed or not: its index, after it is recorded. */
  const called = (options: LanguageModel.ProviderOptions) => Ref.modify(calls, (all): [number, ReadonlyArray<unknown>] => [all.length, [...all, options.toolChoice]]).pipe(
    Effect.tap(() => Ref.update(prompts, (all) => [...all, options.prompt])),
    Effect.tap(() => scenario.providerCall ?? Effect.void),
    Effect.tap(() => Effect.service(CurrentTraceContent).pipe(Effect.flatMap((capture) => Ref.update(traceContent, (all) => [...all, capture])))),
    Effect.tap(() => readKey(calledKeys)),
  )
  const stream = scenario.stream
  const model = yield* LanguageModel.make({
    generateText: (options) => called(options).pipe(
      Effect.flatMap((index) => scenario.refuseFirst === true && index === 0
        ? Effect.fail(imageRefusal)
        : Effect.succeed([...(scenario.script[index] ?? textReply("done"))])),
    ),
    streamText: (options) => stream === undefined
      ? Stream.die("the conformance provider does not stream")
      : Stream.unwrap(called(options).pipe(Effect.map((index) => Stream.fromIterable(stream[index] ?? streamedText("done"))))),
  })
  const invocations = yield* Ref.make(0)
  const handlers = yield* typed.toHandlers({
    probe: ({ n }) => Effect.gen(function* () {
      const step = Option.getOrElse(yield* Effect.service(CurrentAgentStep), () => -1)
      const invocationId = InvocationId.make(`probe:${yield* Ref.getAndUpdate(invocations, (value) => value + 1)}`)
      const base = { step, invocationId, tool: Probe.name, input: { n }, labels: {}, stage: Option.none() }
      yield* events.publish({ _tag: "tool.started", ...base }).pipe(Effect.orDie)
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
  const recorded = yield* Ref.make<ReadonlyArray<LogEntry>>([])
  const records = yield* Ref.make<ReadonlyArray<{ readonly step: number; readonly after: number }>>([])
  const history = yield* Ref.make<ReadonlyArray<AgentMessage>>([{ role: "user", content: "go" }])
  const steers = yield* Ref.make(scenario.steering ?? [])
  const record = (step: number, tail: ReadonlyArray<AgentMessage>) => Ref.get(seen).pipe(
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
  })))
  yield* scenario.before?.(tasks) ?? Effect.void
  const request: StepRequest = {
    run: scenario.run ?? FIRST_RUN,
    tools,
    handlers: Context.merge(handlers, Context.make(LanguageModel.LanguageModel, model)) as Context.Context<never>,
    limits: { maxSteps: scenario.maxSteps ?? 6, toolConcurrency: 1, streaming: scenario.streaming ?? false, requireCompletion: scenario.requireCompletion ?? false },
    initial: Option.fromNullishOr(scenario.initial),
    plan: (info) => (scenario.planned?.(info.stepIndex) ?? Effect.void).pipe(
      Effect.andThen(scenario.replay === true ? Ref.get(history) : Effect.succeed([{ role: "user" as const, content: "go" }])),
      Effect.map((messages) => ({ model: Option.none(), system: "conformance", messages, toolChoice: Option.fromNullishOr(scenario.toolChoice) })),
    ),
    dispatch: (step) => Ref.update(dispatches, (all) => [...all, step]).pipe(Effect.andThen(readKey(dispatchedKeys)), Effect.andThen(scenario.dispatch?.(step) ?? Effect.void)),
    record,
    onMediaRejected: scenario.onMediaRejected ?? (() => Effect.succeed(false)),
    completion: (info) => scenario.completion?.(info.stepIndex, tasks) ?? Effect.succeed(incomplete),
    steering: Ref.modify(steers, (texts): [Option.Option<string>, ReadonlyArray<string>] => [Option.fromNullishOr(texts[0]), texts.slice(1)]),
    correctives: Option.none(),
    events,
    tasks,
    cacheKey: scenario.cacheKey ?? Option.none(),
    captureTraceContent: scenario.captureTraceContent ?? false,
  }
  const result = yield* Effect.result(loop.run(request).pipe(Effect.provideService(CurrentTraceContent, scenario.ambientTraceContent ?? false)))
  return {
    result, events: yield* Ref.get(seen), records: yield* Ref.get(records), providerCalls: yield* Ref.get(calls), prompts: yield* Ref.get(prompts), recorded: yield* Ref.get(recorded),
    dispatches: yield* Ref.get(dispatches), traceContent: yield* Ref.get(traceContent),
    cacheKeys: { dispatched: yield* Ref.get(dispatchedKeys), called: yield* Ref.get(calledKeys) },
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

const stepOf = (event: TurnEvent): Option.Option<number> => "step" in event ? Option.some(event.step) : Option.none()
const indexOf = (events: ReadonlyArray<TurnEvent>, tag: TurnEvent["_tag"], step: number) =>
  events.findIndex((event) => event._tag === tag && Option.contains(stepOf(event), step))

/**
 * The `StepLoop` contract, as checks any implementation must pass:
 * per-step event order, recorded results on `step.ended`, each step ended
 * once with nothing recorded under it after its `step.ended` (the loop's
 * correctives, nudges and steers are the next step's), a step whose
 * completion fails afterwards still `completed`, a malformed step ended
 * `malformed` with no `completion.evaluated`, planned batches
 * without a provider call, forced tool choices, awaiting verdicts, no call
 * after completion, the run's usage, the step cap, the request's
 * `captureTraceContent` provided to its model calls as `CurrentTraceContent`,
 * the request's `cacheKey` provided to its dispatch checks and model calls as
 * `CurrentPromptCacheKey` (the dispatch check compares it with the request's
 * header), a request refused over an image planned again and sent once more
 * when `onMediaRejected` answers true, failing the step when it answers false,
 * a streamed step's reasoning reaching the next request with its provider
 * metadata (Anthropic's signed and redacted thinking), as a non-streamed one's
 * does, and the ids of planned and id-less tool calls distinct across the runs
 * and turns of a session, with the request's run ordinal on every step event.
 */
export const stepLoopConformance = (loop: Context.Service.Shape<typeof StepLoop>): ReadonlyArray<ConformanceCheck> => [
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
    name: "ends each step once, and records nothing under a step after its step.ended (correctives, nudges and steers included)",
    run: Effect.gen(function* () {
      const check = "settled"
      // A malformed step, a stop the host finds incomplete, a steer, a tool call, then the reply.
      const { events, records } = yield* observe(loop, {
        script: [malformedCall("m1"), textReply("not yet"), probeCall("c1", 1), textReply("done")],
        requireCompletion: true, steering: ["steer"],
        completion: (step) => Effect.succeed({ complete: step >= 3, awaiting: [], facts: {} }),
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
    name: "provides the request's cacheKey to its dispatch checks and model calls as CurrentPromptCacheKey",
    run: Effect.gen(function* () {
      const key = Option.some("conformance:cache-key")
      const { cacheKeys } = yield* observe(loop, { script: [probeCall("c1", 1), textReply("done")], cacheKey: key })
      const all = [...cacheKeys.dispatched, ...cacheKeys.called]
      yield* expect("cache-key", cacheKeys.dispatched.length === 2 && cacheKeys.called.length === 2 && all.every((read) => Option.getOrNull(read) === "conformance:cache-key"),
        `with the request's cacheKey ${Option.getOrNull(key)}, the dispatch checks read ${JSON.stringify(cacheKeys.dispatched.map(Option.getOrNull))} and the model calls ${JSON.stringify(cacheKeys.called.map(Option.getOrNull))}`)
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
