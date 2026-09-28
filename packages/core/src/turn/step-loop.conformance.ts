import { LanguageModel, Tool, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"
import { Context, Effect, Option, Ref, Schema, Stream } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { Failure } from "../domain/failure.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { CurrentAgentStep } from "../loop/stepContext.js"
import { entryId } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { InitialBatch, ToolChoice } from "../ports/contribution.port.js"
import type { RunResult, StepLoop, StepRequest } from "../ports/step-loop.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import type { TurnTasksService } from "../ports/turn-events.port.js"
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
/** A scripted provider reply calling `probe`. */
export const probeCall = (id: string, n: number): ReadonlyArray<Part> => [
  { type: "tool-call", id, name: Probe.name, params: { n }, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]
export const textReply = (text: string): ReadonlyArray<Part> => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

interface Scenario {
  readonly script: ReadonlyArray<ReadonlyArray<Part>>
  readonly initial?: InitialBatch
  readonly toolChoice?: ToolChoice
  readonly maxSteps?: number
  readonly completion?: (step: number, tasks: TurnTasksService) => Effect.Effect<CompletionVerdict>
  readonly before?: (tasks: TurnTasksService) => Effect.Effect<void>
}

interface Observed {
  readonly result: RunResult
  readonly events: ReadonlyArray<TurnEvent>
  readonly providerCalls: ReadonlyArray<unknown>
  readonly recorded: ReadonlyArray<LogEntry>
}

const incomplete: CompletionVerdict = { complete: false, awaiting: [], facts: {} }

/** Run one scenario on the loop with a scripted provider, the `probe` tool and an in-memory record. */
const observe = (loop: Context.Service.Shape<typeof StepLoop>, scenario: Scenario): Effect.Effect<Observed, ConformanceFailure> => Effect.scoped(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const events = yield* makeTurnEvents({ maxDepth: 8 })
  const tasks = yield* makeTurnTasks(scope)
  const seen = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
  yield* events.subscribe(Option.some, (event: TurnEvent) => Ref.update(seen, (all) => [...all, event]))
  const calls = yield* Ref.make<ReadonlyArray<unknown>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(calls, (all): [number, ReadonlyArray<unknown>] => [all.length, [...all, options.toolChoice]]).pipe(
      Effect.map((index) => [...(scenario.script[index] ?? textReply("done"))]),
    ),
    streamText: () => Stream.die("the conformance provider does not stream"),
  })
  const invocations = yield* Ref.make(0)
  const handlers = yield* typed.toHandlers({
    probe: ({ n }) => Effect.gen(function* () {
      const step = Option.getOrElse(yield* Effect.service(CurrentAgentStep), () => -1)
      const invocationId = `probe:${yield* Ref.getAndUpdate(invocations, (value) => value + 1)}`
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
  const record = (step: number, tail: ReadonlyArray<AgentMessage>) => Ref.modify(recorded, (all): [ReadonlyArray<LogEntry>, ReadonlyArray<LogEntry>] => {
    const entries = tail.flatMap((message): ReadonlyArray<LogEntry["body"]> => message.role !== "tool"
      ? [{ _tag: "Message", message }]
      : message.content.map((part) => ({
        _tag: "ToolResult", toolCallId: part.toolCallId, toolName: part.toolName, isError: part.isError ?? false,
        encoded: part.output, view: String(part.output), viewVersion: "1", subjects: [], artifacts: [], pinned: false,
      }))).map((body, index): LogEntry => ({ id: entryId("conformance", all.length + index), runId: "conformance", turn: 1, step, at: 0, body }))
    return [entries, [...all, ...entries]]
  })
  yield* scenario.before?.(tasks) ?? Effect.void
  const request: StepRequest = {
    tools,
    handlers: Context.merge(handlers, Context.make(LanguageModel.LanguageModel, model)) as Context.Context<never>,
    limits: { maxSteps: scenario.maxSteps ?? 6, toolConcurrency: 1, streaming: false, requireCompletion: false },
    initial: Option.fromNullishOr(scenario.initial),
    plan: () => Effect.succeed({ model: Option.none(), system: "conformance", messages: [{ role: "user", content: "go" }], toolChoice: Option.fromNullishOr(scenario.toolChoice) }),
    record,
    completion: (info) => scenario.completion?.(info.stepIndex, tasks) ?? Effect.succeed(incomplete),
    steering: Effect.succeed(Option.none()),
    correctives: Option.none(),
    events,
    tasks,
    cacheKey: Option.none(),
  }
  const result = yield* loop.run(request)
  return { result, events: yield* Ref.get(seen), providerCalls: yield* Ref.get(calls), recorded: yield* Ref.get(recorded) }
}).pipe(Effect.mapError((error) => new ConformanceFailure({ check: "run", message: error.message }))))

const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> =>
  holds ? Effect.void : Effect.fail(new ConformanceFailure({ check, message }))

const stepOf = (event: TurnEvent): Option.Option<number> => "step" in event ? Option.some(event.step) : Option.none()
const indexOf = (events: ReadonlyArray<TurnEvent>, tag: TurnEvent["_tag"], step: number) =>
  events.findIndex((event) => event._tag === tag && Option.contains(stepOf(event), step))

/**
 * The `StepLoop` contract, as checks any implementation must pass:
 * per-step event order, recorded results on `step.ended`, planned batches
 * without a provider call, forced tool choices, awaiting verdicts, no call
 * after completion, and the step cap.
 */
export const stepLoopConformance = (loop: Context.Service.Shape<typeof StepLoop>): ReadonlyArray<ConformanceCheck> => [
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
      }))
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
    name: "the step cap ends the run as partial",
    run: Effect.gen(function* () {
      const { providerCalls, result } = yield* observe(loop, { maxSteps: 2, script: [probeCall("c1", 1), probeCall("c2", 2), probeCall("c3", 3)] })
      yield* expect("step-cap", result.outcome === "partial" && result.reason === "step-cap" && providerCalls.length === 2,
        `${result.outcome}/${result.reason} after ${providerCalls.length} provider calls`)
    }),
  },
]
