import { AiError, LanguageModel, Prompt } from "effect/ai"
import type { Response, Tool, Toolkit } from "effect/ai"
import { Array as Arr, Cause, Context, Effect, Exit, Formatter, Match, Metric, Option, Order, Ref, Result, Stream } from "effect"
import { CurrentTraceContent, freezeModelRequest, replayableContext } from "@xandreed/core"
import { foldStreamParts } from "@xandreed/core/internal"
import { CurrentAgentStep } from "@xandreed/core"
import { CurrentEmptyResponseTolerance } from "@xandreed/core"
import type { LoopEvent, StepStatus } from "@xandreed/core"
import type { AgentMessage, AgentResult } from "@xandreed/core"
import { addUsage, elideMediaData, isMediaValue, zeroUsage } from "@xandreed/core"
import type { TokenUsage } from "@xandreed/core"
import type { ModelDispatch } from "@xandreed/core"
import { plannedCallIdOf } from "@xandreed/core"
import type { RunRef } from "@xandreed/core"
import { responseModelOrLegacyOf } from "@xandreed/core/internal"
import { extractUsage, handoffToMessage, responseReasoning, responseText, responseToAgentMessages, responseToolCalls, responseToolResults, toPromptMessages, withToolCallIds, withUsageOnAssistant } from "@xandreed/core/internal"

/**
 * A mid-run fold the `compact` callback hands back: everything before
 * `keepFrom` is replaced by `handoffToMessage(summary)`; `messages[keepFrom..]`
 * survive verbatim. CONTRACT: `keepFrom` must index an assistant message
 * (never split a tool-call from its results) — `safeKeepFrom` guarantees it;
 * the loop ignores a plan that violates the contract (the run continues
 * unfolded, best-effort).
 */
export interface CompactionPlan {
  readonly summary: string
  readonly keepFrom: number
}

/**
 * The provider-agnostic agent loop. `@effect/ai` resolves ONE step's tool
 * calls (its handlers are our Effects) but does not iterate across turns —
 * iteration is ours: each turn maps the message buffer to a `Prompt`, calls
 * `LanguageModel.generateText`, appends the response as the new tail, and
 * re-invokes until the model stops requesting tools, `maxSteps` is hit, or
 * the degenerate-loop breaker fires. State is an immutable fold through
 * a recursive step — the same discipline as foundry's forge loop.
 */

/**
 * The callbacks run with the caller's services `R` and fail with its `E`:
 * a callback's failure fails the step it runs in (its status `failed`), or
 * the run once the step settled, as that failure, typed. The run fails
 * with `E` or a provider's `AiError`.
 */
export interface RunLoopOptions<Tools extends Record<string, Tool.Any>, E, R> {
  /** A host-validated first batch. Runs as step zero through the ordinary
   * Effect AI decoder, instrumented toolkit and durable tail hooks, without
   * another provider request. Provider usage belongs to the host planner. */
  readonly initialStep?: ReadonlyArray<{ readonly name: keyof Tools & string; readonly params: unknown }>
  /**
   * The run this is (`StepRequest.run`): the ids minted for a provider's
   * id-less tool calls are `<turn>.<ordinal>.<step>:<tool>:<n>` and a planned
   * batch's `<turn>.<ordinal>.planned:<n>`, distinct across a session's runs
   * and turns. Without it they are `<step>:<tool>:<n>` and `planned:0:<n>`,
   * which repeat from one run to the next.
   */
  readonly run?: RunRef
  /** Host selection at a real provider boundary. Never called for initialStep.
   * The host may cache its choice for a run; tools and completion remain loop-owned. */
  readonly prepareModel?: (input: {
    readonly stepIndex: number
    readonly messages: ReadonlyArray<AgentMessage>
    readonly activeTools: ReadonlyArray<string>
  }) => Effect.Effect<{
    readonly model: LanguageModel.LanguageModel
    readonly system: Prompt.Prompt
  }, AiError.AiError | E, R>
  /** Validate independently reconstructed durable input immediately before a provider dispatch. */
  readonly beforeDispatch?: (step: number, request: ModelDispatch) => Effect.Effect<void, E, R>
  /**
   * A provider refused a step's request over an image (an `InvalidRequestError`
   * that names one; the argument is what it said). True: the images are
   * dealt with (memory omits them), and the loop renders the step again and
   * sends it once more; false, or absent: the step fails with the refusal.
   */
  readonly onMediaRejected?: (reason: string) => Effect.Effect<boolean, E, R>
  readonly system: string | Prompt.Prompt
  /** The READ side of memory: when present, each provider step sends these
   * messages instead of the loop's own buffer. Persistence still flows through
   * `onTail`, so a memory plugin can rebuild every request from its log. */
  readonly render?: (step: StepView) => Effect.Effect<ReadonlyArray<AgentMessage>, E, R>
  /** Per-step tool choice (e.g. force a delivery tool without removing others). */
  readonly stepDirective?: (step: StepView) => Effect.Effect<{ readonly toolChoice: Option.Option<LoopToolChoice> }, E, R>
  /** Host wording for the loop's own corrective turns. */
  readonly correctives?: {
    readonly malformed?: (tools: ReadonlyArray<string>, description: string) => string
    readonly incomplete?: string
  }
  /** Explicit opt-in: export prompt and result content on step spans
   * (`engine.step.input`, `engine.step.output`), and to the model calls
   * through `CurrentTraceContent`, which the loop provides for the run.
   * Hosts own consent, redaction and exporter retention. Defaults to
   * `CurrentTraceContent` where the run starts: off unless provided. */
  readonly captureTraceContent?: boolean
  readonly messages: ReadonlyArray<AgentMessage>
  readonly toolkit: Toolkit.Toolkit<Tools>
  /** Host completion condition for `step`, checked after the step settled
   * (`onStepSettled`), never after a malformed one. A query: it ends no step.
   * Avoids a paid final prose call when a tool already delivered the
   * complete result. */
  readonly isComplete?: (step: number) => Effect.Effect<boolean, E, R>
  /**
   * Called exactly once per step, after its tail went through `onTail` and
   * before anything is decided (completion, nudges, compaction, steering),
   * with the exit of the step's own call, tools and tail: `completed`,
   * `failed`, `cancelled`, or `malformed` (a response the model could not
   * form, answered with a corrective turn). What is decided afterwards, and
   * fails, fails the run, never the settled step.
   */
  readonly onStepSettled?: (step: number, status: StepStatus) => Effect.Effect<void, E, R>
  /** When true, a model stop cannot substitute for host completion. A bounded
   * corrective turn asks for the missing actions; maxSteps still applies. */
  readonly requireCompletion?: boolean
  /** Run-pinned deterministic capability selection, refreshed between steps
   * and sent in the order returned (append new tools to keep the prefix stable).
   * A capability-expansion tool can update this selection for the next call.
   * Handlers must still enforce their own principal/action policy. */
  readonly activeTools?: () => Effect.Effect<ReadonlyArray<keyof Tools>, E, R>
  /** A ceiling, not a target — a normal run ends when the model stops
   *  calling tools. Default {@link DEFAULT_MAX_STEPS}. */
  readonly maxSteps?: number
  /** Concurrency for resolving one step's tool calls. Default
   *  {@link DEFAULT_TOOL_CONCURRENCY} — bounded so a many-call turn doesn't
   *  stampede the provider. */
  readonly toolConcurrency?: number
  /** Tools designed to be POLLED — repeat calls with unchanged results are
   *  correct for these, so they never count toward the degenerate breaker. */
  readonly pollableTools?: ReadonlyArray<string>
  /** The single event sink — see `LoopEvent`. */
  readonly onEvent?: (event: LoopEvent) => Effect.Effect<void, E, R>
  /**
   * Incremental persistence: called with each turn's appended messages
   * (model responses AND synthetic correctives) the moment they land, so a
   * session is restorable to its last completed turn after a crash, with
   * the step they belong to: a step's response and tool results are its
   * own, recorded before it settles; the loop's own messages (a malformed
   * corrective, a nudge, a steer) belong to the next step, which reads
   * them, and are recorded only when that step runs (a run the step cap,
   * the breaker or completion ends sends none). Returns the absolute store
   * positions aligned with the input.
   */
  readonly onTail?: (
    messages: ReadonlyArray<AgentMessage>,
    step: number,
  ) => Effect.Effect<ReadonlyArray<number>, E, R>
  /**
   * The WITHIN-RUN compaction seam, consulted at turn boundaries while the
   * run continues. Receives the buffer the NEXT turn would send plus the
   * just-finished turn's usage (its `inputTokens` IS the live context cost);
   * `Some(plan)` rewrites the buffer to summary + kept tail. The loop stays
   * pure — the callback owns thresholds, summarization, and persistence.
   */
  readonly compact?: (
    messages: ReadonlyArray<AgentMessage>,
    lastTurnUsage: TokenUsage,
  ) => Effect.Effect<Option.Option<CompactionPlan>, E, R>
  /**
   * Route turns through `streamText`, folding the parts back into the
   * settled turn shape while fanning `assistant_delta` events as tokens
   * flow. Default FALSE. A stream that fails before its first part
   * (scripted providers' `Stream.die` included) falls back to
   * `generateText` — for the REST of the run, not per turn — and emits one
   * `stream_fallback` event with the stream's error.
   */
  readonly streaming?: boolean
  /**
   * MID-TURN steering, consulted at turn boundaries while the run
   * continues (the `compact` seam's twin): `Some(text)` appends a user
   * message the NEXT model call sees — a human's course correction lands
   * at the next step instead of after the whole run. Injected after any
   * fold (steering must never be compacted away) and persisted via
   * `onTail` like every other appended message.
   */
  readonly pendingInput?: () => Effect.Effect<Option.Option<string>, E, R>
}

/** What the loop knows about the step it is about to take. */
export interface StepView {
  readonly stepIndex: number
  /** Active tool names, in activation order. */
  readonly activeTools: ReadonlyArray<string>
  readonly lastUsage: Option.Option<TokenUsage>
}

export type LoopToolChoice = "required" | { readonly tool: string }

export const DEFAULT_MAX_STEPS = 100
export const DEFAULT_TOOL_CONCURRENCY = 4

/**
 * The loop's own quality metrics (Day-4 "trajectory efficiency" vitals) —
 * pure `effect` Metric, exported to Prometheus by providers' TracingLive:
 * `engine_runs_total{engine_outcome,engine_reason}` (task completion rate),
 * `engine_tool_calls_total{engine_tool,engine_ok}` (usage frequency +
 * failed-call rate), `engine_corrections_total{engine_kind}` (malformed
 * recoveries, degenerate nudges, stream fallbacks and steps sent again
 * without the images a provider refused — the self-correction count).
 */
const engineRuns = Metric.counter("engine.runs", {
  description: "agent runs by outcome and reason",
  incremental: true,
})
const engineToolCalls = Metric.counter("engine.tool_calls", {
  description: "tool calls by tool name and result",
  incremental: true,
})
const engineCorrections = Metric.counter("engine.corrections", {
  description: "self-corrections by kind (malformed recovery, degenerate nudge, stream fallback, image refused and resent)",
  incremental: true,
})
const tagged = <Input, State>(
  metric: Metric.Metric<Input, State>,
  tags: Record<string, string>,
): Metric.Metric<Input, State> => Metric.withAttributes(metric, tags)

/**
 * One provider call's usage as `engine.turn` span attributes, under the
 * OpenTelemetry GenAI semantic-convention names: the full input (its cache
 * reads and writes inside it), the full output (its reasoning inside it),
 * and the cache and reasoning shares. effect/ai's own `LanguageModel` span
 * of the call carries the same input and output counts (and
 * `@effect/ai-anthropic` names its cache writes
 * `gen_ai.usage.cache_write.input_tokens`), so a backend should not sum
 * `gen_ai.usage.*` across span levels.
 */
const stepUsageAttributes = (usage: TokenUsage): Record<string, number> => ({
  "gen_ai.usage.input_tokens": usage.inputTokens,
  "gen_ai.usage.output_tokens": usage.outputTokens,
  "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens,
  "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens,
  "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens,
})

/**
 * A run's summed usage as `engine.run` span attributes, under efferent's
 * own names: the GenAI names belong to the calls, and a backend summing
 * them over a trace would count every step twice.
 */
const runUsageAttributes = (usage: TokenUsage): Record<string, number> => ({
  "engine.usage.input_tokens": usage.inputTokens,
  "engine.usage.output_tokens": usage.outputTokens,
  "engine.usage.cache_read_tokens": usage.cacheReadTokens,
  "engine.usage.cache_write_tokens": usage.cacheWriteTokens,
  "engine.usage.reasoning_tokens": usage.reasoningTokens,
  "engine.usage.total_tokens": usage.totalTokens,
})

/**
 * A response the loop can correct: the model's own output does not decode
 * (an unknown tool, a part that does not parse) or a tool call's parameters
 * do not. A provider's protocol failure (`InvalidResponseError`: a body or
 * stream chunk of the wrong shape) is not the model's to correct, so it
 * fails the step like any other provider error.
 */
type MalformedResponse = AiError.AiError & {
  readonly reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError | AiError.ToolNotFoundError
}
const malformedReasons: ReadonlySet<string> = new Set(["InvalidOutputError", "ToolParameterValidationError", "ToolNotFoundError"])
const isMalformed = (error: unknown): error is MalformedResponse =>
  AiError.isAiError(error) && malformedReasons.has(error.reason._tag)

/** A provider's refusal of a request over an image: an invalid request whose message names one. */
type ImageRejection = AiError.AiError & { readonly reason: AiError.InvalidRequestError }
const isImageRejection = (error: unknown): error is ImageRejection =>
  AiError.isAiError(error) && error.reason._tag === "InvalidRequestError" && /image/i.test(error.reason.message)

/** Consecutive malformed responses tolerated before the run fails for real. */
const MAX_MALFORMED = 3

/** Consecutive no-progress turns before the breaker nudges, then force-stops. */
const REPEAT_NUDGE_AT = 3
const REPEAT_BREAK_AT = 5

export const DEGENERATE_REPEAT_NUDGE =
  "You've called the same tool(s) and gotten the same result several times in " +
  "a row — you're looping without making progress. STOP repeating that call. " +
  "Take a DIFFERENT concrete action toward the task; if you're genuinely " +
  "stuck, say what's blocking you and stop."

export const DEGENERATE_LOOP_STOP =
  "[stopped: repeated the same tool call with no progress — the run was looping]"

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/** The longest stream error a `stream_fallback` event carries. */
const FALLBACK_MESSAGE_CHARS = 300

/** A stream's error or defect as text: a string as it is, anything else formatted (an object as JSON, not `[object Object]`). */
const failureText = (failure: unknown): string => typeof failure === "string" ? failure : Formatter.format(failure)

/**
 * A stable signature of one turn's PROGRESS — the sorted multiset of each
 * non-pollable tool's `name:ok:result`. Keyed on the RESULT, not the args: a
 * tool that returns the same thing regardless of its args registers as no
 * progress even when the model churns the arguments. Empty string = the turn
 * must not count (no tool calls, or purely pollable ones).
 */
const progressSignature = (
  content: ReadonlyArray<Response.AnyPart>,
  pollable: ReadonlySet<string>,
): string => {
  const calls = responseToolCalls(content)
  if (calls.length === 0) return ""
  if (calls.every((c) => pollable.has(c.toolName))) return ""
  return Arr.sort(
    responseToolResults(content)
      .filter((r) => !pollable.has(r.toolName))
      .map((r) => `${r.toolName}:${r.ok ? "ok" : "err"}:${clip(JSON.stringify(r.result ?? null), 300)}`),
    Order.String,
  ).join("|")
}

export type Phase = "continue" | "completed" | "step-cap" | "degenerate-loop"

/**
 * The degenerate-loop breaker's fold over one turn's progress signature —
 * PURE, so the nudge-at-3 / break-at-5 policy is tested without a scripted
 * model. An empty signature (no tool calls, or only pollable ones) leaves
 * the count untouched: a turn that did nothing is not a turn that repeated.
 */
export const foldProgress = (
  state: { readonly seen: ReadonlySet<string>; readonly staleTurns: number },
  sig: string,
): {
  readonly stale: number
  readonly seen: ReadonlySet<string>
  readonly nudge: boolean
  readonly broke: boolean
} => {
  const stale = sig === "" ? state.staleTurns : state.seen.has(sig) ? state.staleTurns + 1 : 0
  const seen = sig === "" || state.seen.has(sig) ? state.seen : new Set([...state.seen, sig])
  return {
    stale,
    seen,
    nudge: sig !== "" && stale === REPEAT_NUDGE_AT,
    broke: sig !== "" && stale >= REPEAT_BREAK_AT,
  }
}

/** THE decision after a turn — the only model-driven edge is `wantsMore`
 *  (the provider said "tool-calls" and there were some); the breaker and
 *  the cap are the harness's, and they outrank it in that order. */
export const nextPhase = (facts: {
  readonly broke: boolean
  readonly wantsMore: boolean
  readonly turnIndex: number
  readonly maxSteps: number
}): Phase =>
  facts.broke
    ? "degenerate-loop"
    : !facts.wantsMore
      ? "completed"
      : facts.turnIndex >= facts.maxSteps
        ? "step-cap"
        : "continue"

interface LoopState {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly newTail: ReadonlyArray<AgentMessage>
  readonly finalText: string
  readonly turnIndex: number
  readonly malformedStreak: number
  readonly seen: ReadonlySet<string>
  readonly staleTurns: number
  readonly usage: TokenUsage
  readonly lastUsage: Option.Option<TokenUsage>
  readonly phase: Phase
  /** Trajectory vitals — annotated on the run span at the end. */
  readonly toolCalls: number
  readonly toolFailures: number
  readonly corrections: number
  /** Flips false after a pre-first-part stream failure — the rest of the
   *  run goes straight to `generateText`, no per-turn re-probe. */
  readonly streamingHealthy: boolean
}

/**
 * A step's content as a trace attribute: an image is traced by its type,
 * size and fingerprint, never its bytes (a prompt's `file` part keeps its
 * type and the length of its data; a `Media` value its fingerprint).
 */
const tracedJson = (value: unknown): string => JSON.stringify(value, (_key, field: unknown) =>
  isMediaValue(field) ? elideMediaData(field)
    : typeof field === "object" && field !== null && "type" in field && field.type === "file" && "data" in field && typeof field.data === "string"
      ? { ...field, data: `[${field.data.length} base64 characters]` }
      : field)

export const runLoop = <Tools extends Record<string, Tool.Any>, E = never, R = never>(
  options: RunLoopOptions<Tools, E, R>,
) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "engine.input.messages": options.messages.length })
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    const pollable: ReadonlySet<string> = new Set(options.pollableTools ?? [])
    const captureTraceContent = options.captureTraceContent ?? (yield* Effect.service(CurrentTraceContent))
    // The callbacks run with the caller's services except its step and tolerance (this loop's own win), under the span current where they are called.
    const eventContext = Context.omit(CurrentAgentStep, CurrentEmptyResponseTolerance)(replayableContext(yield* Effect.context<R>()))
    const onEvent = (event: LoopEvent) => (options.onEvent?.(event) ?? Effect.void).pipe(Effect.provide(eventContext))
    // Resolve the toolkit's handlers once — they're stable across turns.
    const toolkit = yield* options.toolkit

    /**
     * A step's execution: its call, its tools and its tail, recorded under
     * it. Its exit is the step's status (`onStepSettled`); a response that
     * does not decode comes back `Malformed`, for the loop to answer.
     */
    const execute = (state: LoopState) =>
      Effect.gen(function* () {
        yield* onEvent({ type: "turn_start", turnIndex: state.turnIndex })
        const active: ReadonlyArray<string> = options.activeTools === undefined ? Object.keys(toolkit.tools) : (yield* options.activeTools().pipe(Effect.provide(eventContext))).map(String)
        // Activation order, not registration order: a newly activated tool is
        // appended, so the declared tool list only ever grows at its end.
        const selectedTools = Object.fromEntries(active.flatMap((name) => Object.hasOwn(toolkit.tools, name) ? [[name, toolkit.tools[name]] as const] : [])) as Tools
        const toolNames = Object.keys(selectedTools)
        const planned = state.turnIndex === 0 && options.initialStep !== undefined
        const stepView: StepView = { stepIndex: state.turnIndex, activeTools: toolNames, lastUsage: state.lastUsage }
        yield* Effect.annotateCurrentSpan({ "engine.tools.active": toolNames })

        const prepared = state.turnIndex === 0 && options.initialStep !== undefined
          ? Option.none<{ readonly model: LanguageModel.LanguageModel; readonly system: Prompt.Prompt }>()
          : options.prepareModel === undefined
            ? Option.none<{ readonly model: LanguageModel.LanguageModel; readonly system: Prompt.Prompt }>()
            : Option.some(yield* options.prepareModel({ stepIndex: state.turnIndex, messages: state.messages, activeTools: toolNames }).pipe(Effect.provide(eventContext)))
        const baseSystem = Option.match(prepared, { onNone: () => options.system, onSome: (value) => value.system })
        const instructions = typeof baseSystem === "string"
          ? Prompt.make([{ role: "system", content: baseSystem }])
          : baseSystem
        const directive = options.stepDirective === undefined ? Option.none<LoopToolChoice>() : (yield* options.stepDirective(stepView).pipe(Effect.provide(eventContext))).toolChoice

        // One provider attempt over the step's messages, rendered for it: a request refused over an
        // image before any part of its response arrived is attempted once more, rendered again after
        // `onMediaRejected` dealt with the images. Once a part arrived, deltas went out and tool handlers
        // may have run, so a refusal then fails the step like any other failure after the first part.
        const partSeen = yield* Ref.make(false)
        const attempt = Effect.gen(function* () {
          const visible = options.render === undefined ? state.messages : yield* options.render(stepView).pipe(Effect.provide(eventContext))
          const prompt = freezeModelRequest(Prompt.concat(instructions, Prompt.make(toPromptMessages(visible))))

          if (captureTraceContent)
            yield* Effect.annotateCurrentSpan({
              "engine.step.input": tracedJson({ messages: prompt.content, activeTools: toolNames }),
            })

          const toolSequence = yield* Ref.make(0)
          const instrumented: Toolkit.WithHandler<Tools> = {
            tools: selectedTools,
            handle: (name, params, providerCallId, parseOptions) => Effect.gen(function* () {
              const sequence = yield* Ref.getAndUpdate(toolSequence, (value) => value + 1)
              const toolCallId = `execution:${state.turnIndex}:${sequence}`
              yield* onEvent({ type: "tool_start", turnIndex: state.turnIndex, toolCallId, toolName: String(name), args: params })
              const results = yield* toolkit.handle(name, params, providerCallId, parseOptions)
              return results.pipe(
                // Parameters that do not decode are a malformed response whatever
                // the tool's failure mode: the loop answers with a corrective turn.
                Stream.mapEffect((result) => result.isFailure && result.failureOrigin === "parameters"
                  ? Effect.fail(result.result as AiError.AiError)
                  : Effect.succeed(result)),
                Stream.tap((result) => result.preliminary ? Effect.void : onEvent({
                  type: "tool_end", turnIndex: state.turnIndex, toolCallId, toolName: String(name), args: params,
                  ok: !result.isFailure, result: result.result, encoded: result.encodedResult,
                })),
              )
            }) as never,
          }
          const callOptions = Object.freeze({
            prompt,
            toolkit: instrumented,
            concurrency: options.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
            ...Option.match(directive, { onNone: () => ({}), onSome: (toolChoice) => ({ toolChoice: toolChoice as never }) }),
          })

          const dispatchModel = Option.isSome(prepared) ? prepared.value.model : yield* LanguageModel.LanguageModel
          const beforeDispatch = options.beforeDispatch === undefined ? Effect.void : options.beforeDispatch(state.turnIndex, {
            prompt, tools: Object.values(selectedTools), toolChoice: Option.getOrElse(directive, () => "auto"), model: dispatchModel,
          }).pipe(Effect.provide(eventContext))

          /** Both paths land on the SAME settled shape — after this point the
           *  turn body is identical code, streamed or not. */
          // Tools declare no dependencies (handlers carry their own context), so a
          // model call needs the model alone; `Tool.Any` would widen it to `any`.
          // It fails with the provider's error, or with the caller's from the
          // dispatch check and the tool events.
          const generated = (planned ? LanguageModel.generateText(callOptions) : beforeDispatch.pipe(Effect.andThen(Effect.suspend(() =>
            dispatchModel.generateText(callOptions),
          )))) as Effect.Effect<LanguageModel.GenerateTextResponse<Tools, "opaque">, AiError.AiError | E, LanguageModel.LanguageModel>
          const settled = (streamingHealthy: boolean) =>
            generated.pipe(
              Effect.map((res) => ({
                _tag: "ok" as const,
                content: res.content,
                finishReason: res.finishReason,
                usage: res.usage,
                streamingHealthy,
              })),
            )

          // The streamed twin: fold parts into the settled shape, fanning
          // assistant_delta events while tokens flow. A failure or defect
          // BEFORE the first part (a scripted provider's Stream.die, a broken
          // gateway) falls back to generateText for the rest of the run, with
          // one stream_fallback event; after the first part, failures ride the
          // existing turn handling (tool handlers may already have run — a
          // replay would duplicate).
          // The dispatch check runs first, outside that fallback: a failed
          // check fails the step, it is no stream failure (the fallback's own
          // call is checked again).
          const streamed = Effect.gen(function* () {
            yield* beforeDispatch
            const folded = yield* foldStreamParts(
              (Stream.unwrap(Effect.sync(() => dispatchModel.streamText(callOptions))) as Stream.Stream<Response.AnyPart, AiError.AiError | E, LanguageModel.LanguageModel>).pipe(
                Stream.tap(() => Ref.set(partSeen, true)),
              ),
              (delta) =>
                onEvent({
                  type: "assistant_delta",
                  turnIndex: state.turnIndex,
                  channel: delta.channel,
                  id: delta.id,
                  delta: delta.delta,
                  ...(delta.toolName === undefined ? {} : { toolName: delta.toolName }),
                }),
            ).pipe(
              Effect.map((turn) =>
                Result.succeed({
                  _tag: "ok" as const,
                  content: turn.content,
                  finishReason: turn.finishReason,
                  usage: turn.usage,
                  streamingHealthy: true,
                }),
              ),
              // An image refusal is the request's, not the stream's: no fallback would send it.
              Effect.catch((err) =>
                Ref.get(partSeen).pipe(
                  Effect.flatMap((armed) =>
                    armed || isImageRejection(err) ? Effect.fail(err) : Effect.succeed(Result.fail(failureText(err))),
                  ),
                ),
              ),
              Effect.catchDefect((defect) =>
                Ref.get(partSeen).pipe(
                  Effect.flatMap((armed) =>
                    armed ? Effect.die(defect) : Effect.succeed(Result.fail(failureText(defect))),
                  ),
                ),
              ),
            )
            return yield* Result.match(folded, {
              onSuccess: Effect.succeed,
              onFailure: (failure) =>
                Effect.logWarning(
                  "streaming failed before any part arrived — falling back to generateText for this run",
                ).pipe(
                  Effect.andThen(onEvent({ type: "stream_fallback", turnIndex: state.turnIndex, message: failure.slice(0, FALLBACK_MESSAGE_CHARS) })),
                  Effect.andThen(Metric.update(tagged(engineCorrections, { "engine.kind": "stream-fallback" }), 1)),
                  Effect.andThen(settled(false)),
                ),
            })
          })

          const initial = Effect.gen(function* () {
            const provider = yield* LanguageModel.make({
              generateText: () => Effect.succeed([...(options.initialStep ?? []).map((call, index) => ({
                type: "tool-call" as const, id: options.run === undefined ? `planned:0:${index}` : plannedCallIdOf(options.run, index), name: call.name,
                params: call.params, providerExecuted: false,
              })), { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: {}, outputTokens: {} } }]),
              streamText: () => Stream.empty,
            })
            yield* Effect.annotateCurrentSpan("engine.step.host_planned", true)
            return yield* settled(state.streamingHealthy).pipe(Effect.provideService(LanguageModel.LanguageModel, provider))
          })
          const useStreaming = options.streaming === true && state.streamingHealthy
          return yield* (planned ? initial : useStreaming ? streamed : settled(state.streamingHealthy))
        })
        const outcome = yield* attempt.pipe(
          Effect.catch((err) => Effect.gen(function* () {
            const onMediaRejected = options.onMediaRejected
            const armed = yield* Ref.get(partSeen)
            if (planned || armed || onMediaRejected === undefined || !isImageRejection(err)) return yield* Effect.fail(err)
            return yield* onMediaRejected(clip(err.reason.message, 600)).pipe(
              Effect.provide(eventContext),
              Effect.flatMap((retry) => retry
                ? Effect.logWarning(`the provider refused an image; sending the step again with its images as labels: ${clip(err.reason.message, 300)}`).pipe(
                  Effect.andThen(Metric.update(tagged(engineCorrections, { "engine.kind": "media-rejected" }), 1)),
                  Effect.andThen(attempt),
                )
                : Effect.fail(err)),
            )
          })),
          Effect.catch((err) =>
            isMalformed(err)
              ? Effect.succeed({ _tag: "malformed" as const, err: err as MalformedResponse })
              : Effect.fail(err),
          ),
          // Once the run has tool calls, a following empty response is the
          // model saying "done" — adapters must return it (the fold below
          // ends the turn) instead of rejecting it into the patient outage
          // ladder, which parks the turn until a deadline kills it.
          Effect.provideService(CurrentEmptyResponseTolerance, state.toolCalls > 0),
        )

        // A response that doesn't decode — a hallucinated tool NAME or a
        // wrong-shaped param set (both fail inside generateText, before any
        // handler runs, so `failureMode: "return"` never sees them): the step
        // settles `malformed`, and the loop answers it (`recover`).
        if (outcome._tag === "malformed") return { _tag: "Malformed" as const, err: outcome.err, toolNames }

        // Mint deterministic ids for id-less tool calls BEFORE the content
        // fans out into events + persisted messages (durable UI identity).
        const content = withToolCallIds(outcome.content, state.turnIndex, options.run)
        const usage = extractUsage(outcome.usage, content)
        yield* Effect.annotateCurrentSpan({
          "engine.step.finish_reason": outcome.finishReason,
          "engine.step.usage_available": !planned,
          ...(!planned ? { "engine.step.usage": JSON.stringify(usage), ...stepUsageAttributes(usage) } : {}),
          ...(captureTraceContent
            ? { "engine.step.output": tracedJson({ content, usage, finishReason: outcome.finishReason }) }
            : {}),
        })
        const model = responseModelOrLegacyOf(content)
        const tail = planned ? responseToAgentMessages(content) : withUsageOnAssistant(responseToAgentMessages(content), usage, model)
        // Persist BEFORE the events fire so the assistant message's durable
        // position is known when its event is emitted (UIs key on it).
        const positions = yield* options.onTail?.(tail, state.turnIndex) ?? Effect.succeed([])
        const assistantAt = tail.findIndex((m) => m.role === "assistant")
        const assistantPosition =
          assistantAt >= 0 ? Option.fromNullishOr(positions[assistantAt]) : Option.none<number>()

        const text = responseText(content)
        const toolCalls = responseToolCalls(content)
        yield* onEvent({
          type: "assistant_message",
          turnIndex: state.turnIndex,
          text,
          reasoning: responseReasoning(content),
          toolCalls,
          usage,
          ...Option.match(model, { onNone: () => ({}), onSome: (id) => ({ model: id }) }),
          ...Option.match(assistantPosition, {
            onNone: () => ({}),
            onSome: (position) => ({ position }),
          }),
        })
        const toolResults = responseToolResults(content)
        yield* Effect.forEach(toolResults, (tr) => Metric.update(tagged(engineToolCalls, {
          "engine.tool": tr.toolName, "engine.ok": tr.ok ? "true" : "false",
        }), 1), { concurrency: 1 })
        return {
          _tag: "Responded" as const,
          content, finishReason: outcome.finishReason, usage, tail, text, toolCalls, toolResults, planned,
          streamingHealthy: outcome.streamingHealthy,
        }
      })

    type Executed = Effect.Success<ReturnType<typeof execute>>
    type Malformed = Extract<Executed, { readonly _tag: "Malformed" }>
    type Responded = Extract<Executed, { readonly _tag: "Responded" }>

    /** The step's status: its execution's exit, nothing decided after it. */
    const statusOf = (exit: Exit.Exit<Executed, unknown>): StepStatus => Exit.match(exit, {
      onSuccess: (executed): StepStatus => executed._tag === "Malformed" ? "malformed" : "completed",
      onFailure: (cause): StepStatus => Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed",
    })
    const settle = (step: number, status: StepStatus) =>
      (options.onStepSettled?.(step, status) ?? Effect.void).pipe(Effect.andThen(onEvent({ type: "turn_end", turnIndex: step, status })))

    /**
     * After a malformed step: feed the decode error back as a corrective
     * turn and retry, bounded. The corrective is what the next step reads,
     * so it is recorded under that step, and only when that step runs.
     */
    const recover = (state: LoopState, malformed: Malformed) => Effect.gen(function* () {
      const streak = state.malformedStreak + 1
      if (streak >= MAX_MALFORMED) return yield* Effect.fail(malformed.err)
      // A corrective turn is a turn: the step cap counts it too, so a
      // malformed streak can never carry a run past its ceiling.
      const recoveredIndex = state.turnIndex + 1
      if (recoveredIndex >= maxSteps) {
        yield* Effect.logWarning(`step cap reached while recovering from a malformed response`)
        return { ...state, turnIndex: recoveredIndex, malformedStreak: streak, phase: "step-cap" } satisfies LoopState
      }
      const reason = malformed.err.reason
      const desc = clip("description" in reason ? reason.description : reason.message, 600)
      yield* Effect.logWarning(`recovering from a malformed response: ${desc}`)
      yield* Metric.update(tagged(engineCorrections, { "engine.kind": "malformed" }), 1)
      const corrective: AgentMessage = {
        role: "user",
        content: options.correctives?.malformed?.(malformed.toolNames, desc) ??
          `Your previous reply could not be parsed: ${desc}\n\n` +
          `This usually means you called a tool that doesn't exist or used the ` +
          `wrong argument shape. The only tools available are: ${malformed.toolNames.join(", ")}. ` +
          `Reply again using one of those tools, or plain text if you're done.`,
      }
      yield* options.onTail?.([corrective], recoveredIndex) ?? Effect.void
      return {
        ...state,
        messages: [...state.messages, corrective],
        newTail: [...state.newTail, corrective],
        turnIndex: recoveredIndex,
        malformedStreak: streak,
        corrections: state.corrections + 1,
      } satisfies LoopState
    })

    /**
     * After a step that settled with a response: the breaker, completion,
     * compaction and steering. What they append (a nudge, a steer) is the
     * next step's input, recorded under it, and only when the run goes on
     * to that step: a run that ends here (the cap, the breaker, completion)
     * records nothing for a step that never runs.
     */
    const decide = (state: LoopState, responded: Responded) => Effect.gen(function* () {
      const { content, usage, tail, text, toolCalls, toolResults } = responded
      const turnIndex = state.turnIndex + 1

      // --- Degenerate-loop circuit breaker ---
      // A turn whose progress signature was already seen produced nothing
      // new; count consecutive stale turns, nudge once, then force-stop.
      const sig = progressSignature(content, pollable)
      const progress = foldProgress(state, sig)
      const { stale, seen } = progress

      const finalText = text.length > 0 ? text : state.finalText
      const completed = yield* options.isComplete?.(state.turnIndex) ?? Effect.succeed(false)
      const requireMore = !completed && options.requireCompletion === true
      const wantsMore = !completed && (requireMore || responded.finishReason === "tool-calls" && toolCalls.length > 0)
      const broke = progress.broke
      const phase = nextPhase({ broke, wantsMore, turnIndex, maxSteps })
      yield* broke
        ? Effect.logWarning(`breaking a degenerate tool-call loop after ${stale} stale turns`)
        : Effect.void

      // --- The next step's input: a nudge, a completion corrective ---
      const continues = phase === "continue"
      const nudge: ReadonlyArray<AgentMessage> = continues && progress.nudge
        ? [{ role: "user", content: DEGENERATE_REPEAT_NUDGE }]
        : []
      yield* nudge.length > 0 ? (options.onTail?.(nudge, turnIndex) ?? Effect.void) : Effect.void
      yield* nudge.length > 0
        ? Metric.update(tagged(engineCorrections, { "engine.kind": "degenerate-nudge" }), 1)
        : Effect.void
      const completionNudge: ReadonlyArray<AgentMessage> = continues && requireMore && toolCalls.length === 0
        ? [{ role: "user", content: options.correctives?.incomplete ?? "The host reports that required actions are incomplete. Your ordinary text is not a delivered result. Complete the requested work using the available tools, or use an explicit supported failure/clarification action if the evidence is missing." }]
        : []
      yield* completionNudge.length > 0 ? (options.onTail?.(completionNudge, turnIndex) ?? Effect.void) : Effect.void

      // --- Within-run compaction (turn boundaries only) ---
      // Consulted only while the run CONTINUES; the buffer rewrite is
      // load-side (persisted history and `newTail` untouched). A plan that
      // violates the assistant-boundary contract is ignored, never applied.
      const nextMessages = [...state.messages, ...tail, ...nudge, ...completionNudge]
      const plan =
        continues && options.compact !== undefined
          ? yield* options.compact(nextMessages, usage)
          : Option.none<CompactionPlan>()
      const applied = Option.filter(
        plan,
        (p) =>
          p.keepFrom > 0 &&
          p.keepFrom < nextMessages.length &&
          nextMessages[p.keepFrom]?.role === "assistant",
      )
      yield* Option.match(applied, {
        onNone: () => Effect.void,
        onSome: (p) =>
          onEvent({
            type: "compaction",
            turnIndex: state.turnIndex,
            tokens: usage.inputTokens,
            kept: nextMessages.length - p.keepFrom,
          }),
      })

      // --- Mid-turn steering (turn boundaries, running runs only) ---
      // Consulted AFTER the fold so a steering message can never be
      // compacted away before the model sees it.
      const steered =
        continues && options.pendingInput !== undefined
          ? yield* options.pendingInput()
          : Option.none<string>()
      const steerTail: ReadonlyArray<AgentMessage> = Option.match(steered, {
        onNone: () => [],
        onSome: (text) => [{ role: "user", content: text }],
      })
      yield* steerTail.length > 0 ? (options.onTail?.(steerTail, turnIndex) ?? Effect.void) : Effect.void

      return {
        messages: [
          ...Option.match(applied, {
            onNone: () => nextMessages,
            onSome: (p) => [handoffToMessage(p.summary), ...nextMessages.slice(p.keepFrom)],
          }),
          ...steerTail,
        ],
        newTail: [...state.newTail, ...tail, ...nudge, ...completionNudge, ...steerTail],
        finalText: broke && finalText.length === 0 ? DEGENERATE_LOOP_STOP : finalText,
        turnIndex,
        malformedStreak: 0,
        seen,
        staleTurns: stale,
        usage: addUsage(state.usage, usage),
        lastUsage: responded.planned ? state.lastUsage : Option.some(usage),
        phase,
        toolCalls: state.toolCalls + toolCalls.length,
        toolFailures: state.toolFailures + toolResults.filter((tr) => !tr.ok).length,
        corrections: state.corrections + (nudge.length > 0 ? 1 : 0),
        streamingHealthy: responded.streamingHealthy,
      } satisfies LoopState
    })

    /**
     * One step, in two parts: it executes (the call, the tools, the tail)
     * and settles once with that exit's status; then the loop decides what
     * follows. A failure in the decision fails the run, not the step.
     */
    const step = (state: LoopState) =>
      execute(state).pipe(
        Effect.onExit((exit) => settle(state.turnIndex, statusOf(exit))),
        Effect.flatMap((executed): Effect.Effect<LoopState, AiError.AiError | E, R> => Match.valueTags(executed, {
          Malformed: (malformed) => recover(state, malformed),
          Responded: (responded) => decide(state, responded),
        })),
        Effect.provideService(CurrentAgentStep, Option.some(state.turnIndex)),
        Effect.withSpan("engine.turn", {
          attributes: { "engine.turn": state.turnIndex, "engine.step": state.turnIndex + 1 },
        }))

    /** Steps until the loop leaves `continue` (Effect runs the recursion stack-safely). */
    type Settled = LoopState & { readonly phase: Exclude<LoopState["phase"], "continue"> }
    const runSteps = (
      state: LoopState,
    ): Effect.Effect<Settled, Effect.Error<ReturnType<typeof step>>, Effect.Services<ReturnType<typeof step>>> =>
      state.phase === "continue" ? Effect.flatMap(step(state), runSteps) : Effect.succeed(state as Settled)
    const initial: LoopState = {
        messages: options.messages,
        newTail: [],
        finalText: "",
        turnIndex: 0,
        malformedStreak: 0,
        seen: new Set<string>(),
        staleTurns: 0,
        usage: zeroUsage,
        lastUsage: Option.none(),
        phase: "continue",
        toolCalls: 0,
        toolFailures: 0,
        corrections: 0,
        streamingHealthy: true,
      }
    // The run's model calls read the switch too (the models plugin's `llm.reasoning`).
    const final = yield* runSteps(initial).pipe(Effect.provideService(CurrentTraceContent, captureTraceContent))

    const { outcome, reason } = Match.value(final.phase).pipe(
      Match.when("completed", () => ({ outcome: "ok" as const, reason: "completed" as const })),
      Match.when("step-cap", () => ({
        outcome: "partial" as const,
        reason: "step-cap" as const,
      })),
      Match.when("degenerate-loop", () => ({
        outcome: "partial" as const,
        reason: "degenerate-loop" as const,
      })),
      Match.exhaustive,
    )
    yield* onEvent({ type: "agent_end", outcome, reason, finalText: final.finalText })
    yield* Metric.update(
      tagged(engineRuns, { "engine.outcome": outcome, "engine.reason": reason }),
      1,
    )
    // The run span states its verdict AND its trajectory vitals — a
    // "completed" run with 25 steps, five failed calls, and three
    // corrections is a low-quality success visible at a glance (Day 4).
    yield* Effect.annotateCurrentSpan({
      "engine.outcome": outcome,
      "engine.reason": reason,
      "engine.turns": final.turnIndex,
      ...runUsageAttributes(final.usage),
      "engine.tool_calls": final.toolCalls,
      "engine.tool_calls.failed": final.toolFailures,
      "engine.corrections": final.corrections,
      error: outcome !== "ok",
    })
    return {
      finalText: final.finalText,
      messages: final.messages,
      newTail: final.newTail,
      outcome,
      reason,
      usage: final.usage,
    } satisfies AgentResult
  }).pipe(Effect.withSpan("engine.run"))
