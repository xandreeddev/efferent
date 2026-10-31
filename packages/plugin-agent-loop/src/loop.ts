import { AiError, LanguageModel, Prompt, Response } from "effect/ai"
import type { Tool, Toolkit } from "effect/ai"
import { Array as Arr, Cause, Context, Effect, Exit, Formatter, Match, Metric, Option, Order, Ref, Result, Schema, Stream } from "effect"
import { acceptedModelInputOf, CurrentTraceContent, freezeModelRequest, modelFailureCodeOf, modelFailureMessageOf, modelFailureOf, modelOverflowEvidenceOf, replayableContext } from "@xandreed/core"
import { CurrentToolResultReceipt, foldStreamParts, makeToolResultReceipt, withToolResultReceiptGuard } from "@xandreed/core/internal"
import { CurrentAgentRun, CurrentAgentStep, DegeneratePolicy, MalformedLimit } from "@xandreed/core"
import { CurrentEmptyResponseTolerance } from "@xandreed/core"
import type { AcceptedModelInput, AgentMessage, AgentResult, HarnessError, ModelFailureKind, ModelOverflowEvidence, StepStatus } from "@xandreed/core"
import { addUsage, clipTo, elideMediaData, framed, harnessError, hostNote, isMediaValue, isTurnError, zeroUsage } from "@xandreed/core"
import type { TokenUsage } from "@xandreed/core"
import type { ModelDispatch } from "@xandreed/core"
import { plannedCallIdOf, responseModelOf, ToolCallId } from "@xandreed/core"
import type { RunRef } from "@xandreed/core"
import { extractUsage, handoffToMessage, responseReasoning, responseText, responseToAgentMessages, responseToolCalls, responseToolResults, toPromptMessages, withToolCallIds, withUsageOnAssistant } from "@xandreed/core/internal"
import type { LoopEvent } from "./loop-event.entity.js"
import { DUPLICATE_CALL_IDS, duplicateCallCorrective, lengthCorrective, malformedCall, MAX_CUT_CORRECTIVES, replyCutFailure, truncatedMessage, verdictOf } from "./response-gate.entity.functions.js"
import type { CutReason } from "./response-gate.entity.js"
import { claimRecovery, initialAttempt, settledAttempt, visibleAttempt } from "./request-attempt.entity.functions.js"

/**
 * A mid-run fold the `compact` callback hands back: everything before
 * `keepFrom` is replaced by `handoffToMessage(summary)`; `messages[keepFrom..]`
 * survive verbatim. CONTRACT: `keepFrom` must index an assistant message
 * (never split a tool-call from its results: a tool message follows the
 * assistant message whose calls it answers); the loop ignores a plan that
 * violates the contract (the run continues unfolded, best-effort).
 *
 * @public
 */
export interface CompactionPlan {
  readonly summary: string
  readonly keepFrom: number
}

/**
 * The provider-agnostic agent loop. Each turn maps the message buffer to a
 * `Prompt` and calls `LanguageModel.generateText` (or `streamText`) with tool
 * call resolution off: the response comes back whole first, and the loop
 * runs its tool calls itself, only when the response is whole (`verdictOf`:
 * a reply cut short runs none of them) and every call names a tool the step
 * has with parameters that decode (`malformedCall`). It then appends the
 * response and the results as the new tail, and re-invokes until the model
 * stops requesting tools, `maxSteps` is hit, or the degenerate-loop breaker
 * fires. State is an immutable fold through a recursive step — the same
 * discipline as foundry's forge loop.
 */

/**
 * The callbacks run with the caller's services `R` and fail with its `E`:
 * a callback's failure fails the step it runs in (its status `failed`), or
 * the run once the step settled, as that failure, typed. The run fails
 * with `E`, a provider's `AiError`, or a `HarnessError` `loop.truncated`
 * (a reply cut short that the loop does not answer: a cut other than the
 * output limit, or one more after `MAX_CUT_CORRECTIVES` in a row).
 *
 * @public
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
  /**
   * Compact an explicit overflowing request before any nonempty assistant
   * delta escaped. True authorizes one same-step resend with fresh context;
   * false or absence preserves the original failure. Callback failures stay
   * the caller's. The step's choices and model remain frozen.
   */
  readonly onContextOverflow?: (step: number, evidence?: ModelOverflowEvidence) => Effect.Effect<boolean, E, R>
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
   * (`onStepSettled`), never after a malformed or a truncated one. A query: it ends no step.
   * Avoids a paid final prose call when a tool already delivered the
   * complete result. */
  readonly isComplete?: (step: number) => Effect.Effect<boolean, E, R>
  /** Yield before the first step or after successful settled work, before completion, compaction or further input. */
  readonly waiting?: Effect.Effect<boolean, E, R>
  /**
   * Called exactly once per step, after its tail went through `onTail` and
   * before anything is decided (completion, nudges, compaction, steering),
   * with the exit of the step's own call, tools and tail: `completed`,
   * `failed`, `cancelled`, `malformed` (a response the model could not
   * form, answered with a corrective turn), or `truncated` (a response cut
   * short, none of its tool calls run). What is decided afterwards, and
   * fails, fails the run, never the settled step.
   */
  readonly onStepSettled?: (step: number, status: StepStatus) => Effect.Effect<void, E, R>
  /** When true, a model stop cannot substitute for host completion. A bounded
   * corrective turn asks for the missing actions (never after a paused reply,
   * which the next call continues); maxSteps still applies. */
  readonly requireCompletion?: boolean
  /** Repeated-result protection; defaults to nudge after 3 stale steps and stop after 5. */
  readonly degenerate?: DegeneratePolicy
  /** Fail on this consecutive malformed response; default 3 permits two corrective requests. */
  readonly malformedLimit?: number
  /** Run-pinned deterministic capability selection, refreshed between steps
   * and sent in the order returned (append new tools to keep the prefix stable).
   * A capability-expansion tool can update this selection for the next call.
   * Handlers must still enforce their own principal/action policy. */
  readonly activeTools?: () => Effect.Effect<ReadonlyArray<keyof Tools>, E, R>
  /** A ceiling, not a target — a normal run ends when the model stops
   *  calling tools. Default {@link DEFAULT_MAX_STEPS}. */
  readonly maxSteps?: number
  /** Concurrency for running one step's tool calls, which the loop runs
   *  itself once the response is whole. Default
   *  {@link DEFAULT_TOOL_CONCURRENCY} — bounded so a many-call turn doesn't
   *  stampede the provider. */
  readonly toolConcurrency?: number
  /** Tools designed to be POLLED — repeat calls with unchanged results are
   *  correct for these, so they never count toward the degenerate breaker. */
  readonly pollableTools?: ReadonlyArray<string>
  /** The single event sink — see `LoopEvent`. */
  readonly onEvent?: (event: LoopEvent) => Effect.Effect<void, E, R>
  /**
   * Incremental persistence: called with the assistant response before any
   * tool handler runs, then each final tool result as it returns (completion
   * order, without waiting for siblings), and synthetic correctives. A
   * durable implementation stores each batch before returning, with
   * the step they belong to: a step's response and tool results are its
   * own, recorded before it settles; the loop's own messages (a malformed
   * or a length corrective, a nudge, a steer) belong to the next step, which reads
   * them, and are recorded only when that step runs (a run the step cap,
   * the breaker or completion ends sends none). Returns the absolute store
   * positions aligned with the input.
   * A real accepted model response supplies `accepted`, including when the
   * tail is empty. Planned batches, results and loop messages omit it. An
   * unusable supplied fact clears prior calibration; omission preserves it.
   */
  readonly onTail?: (
    messages: ReadonlyArray<AgentMessage>,
    step: number,
    accepted?: AcceptedModelInput,
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
  /** A fresh probe after settlement and an atomic take after the next step starts.
   * Taken messages are already durable and never passed through onTail again. */
  readonly durableInput?: {
    readonly pending: () => Effect.Effect<boolean, E, R>
    readonly take: (step: number) => Effect.Effect<ReadonlyArray<AgentMessage>, E, R>
  }
}

/**
 * What the loop knows about the step it is about to take.
 *
 * @public
 */
export interface StepView {
  readonly stepIndex: number
  /** Active tool names, in activation order. */
  readonly activeTools: ReadonlyArray<string>
  readonly lastUsage: Option.Option<TokenUsage>
}

/** @public */
export type LoopToolChoice = "required" | { readonly tool: string }

/** @public */
export const DEFAULT_MAX_STEPS = 100
/** @public */
export const DEFAULT_TOOL_CONCURRENCY = 4

/**
 * The loop's own quality metrics (Day-4 "trajectory efficiency" vitals) —
 * pure `effect` Metric, exported to Prometheus by providers' TracingLive:
 * `engine_runs_total{engine_outcome,engine_reason}` (task completion rate),
 * `engine_tool_calls_total{engine_tool,engine_ok}` (usage frequency +
 * failed-call rate), `engine_corrections_total{engine_kind}` (malformed
 * recoveries, replies cut at the output limit answered with a corrective,
 * degenerate nudges, stream fallbacks and steps sent again without the
 * images a provider refused — the self-correction count).
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
  description: "self-corrections by kind (malformed recovery, reply cut at the output limit, degenerate nudge, stream fallback, image refused and resent)",
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
 * (a part that does not parse: `InvalidOutputError`), or a whole response's
 * call names a tool the step does not have (`ToolNotFoundError`) or gives
 * parameters its schema does not decode (`ToolParameterValidationError`),
 * both of which the loop makes from `malformedCall`. A provider adapter may
 * raise either of the last two itself, before any finish part: effect/ai's
 * Anthropic and OpenAI adapters fail a call whose arguments are not valid
 * JSON with `ToolParameterValidationError`, a call a cut at the output
 * limit left unfinished included, which the loop then answers as malformed,
 * not as cut (the models plugin's chat completions client keeps such a
 * call for the gate). A provider's protocol
 * failure (`InvalidResponseError`: a body or stream chunk of the wrong
 * shape) is not the model's to correct, so it fails the step like any other
 * provider error.
 */
type MalformedResponse = AiError.AiError & {
  readonly reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError | AiError.ToolNotFoundError
}
const malformedReasons: ReadonlySet<string> = new Set(["InvalidOutputError", "ToolParameterValidationError", "ToolNotFoundError"])
const isMalformed = (error: unknown): error is MalformedResponse =>
  AiError.isAiError(error) && Option.isNone(modelFailureOf(error)) && malformedReasons.has(error.reason._tag)

const permanentModelFailures: ReadonlySet<ModelFailureKind> = new Set(["ContextOverflow", "Authentication", "InvalidRequest", "Quota", "InvalidResponse"])
const isPermanentModelFailure = (error: unknown): boolean =>
  Option.exists(modelFailureOf(error), (kind) => permanentModelFailures.has(kind))

/** A provider's refusal of a request over an image: an invalid request whose message names one. */
type ImageRejection = AiError.AiError & { readonly reason: AiError.InvalidRequestError }
const isImageRejection = (error: unknown): error is ImageRejection =>
  AiError.isAiError(error) && error.reason._tag === "InvalidRequestError" && /image/i.test(error.reason.message)

/** Consecutive malformed responses tolerated before the run fails for real. */
const DEFAULT_MALFORMED_LIMIT = 3

/** Consecutive no-progress turns before the breaker nudges, then force-stops. */
const REPEAT_NUDGE_AT = 3
const REPEAT_BREAK_AT = 5
const defaultDegenerate: DegeneratePolicy = { _tag: "Enabled", nudgeAfter: REPEAT_NUDGE_AT, breakAfter: REPEAT_BREAK_AT }
const loopPolicy = Schema.Struct({ degenerate: DegeneratePolicy, malformedLimit: MalformedLimit })

/** @public */
export const DEGENERATE_REPEAT_NUDGE =
  "You've called the same tool(s) and gotten the same result several times in " +
  "a row — you're looping without making progress. STOP repeating that call. " +
  "Take a DIFFERENT concrete action toward the task; if you're genuinely " +
  "stuck, say what's blocking you and stop."

/** @public */
export const DEGENERATE_LOOP_STOP =
  "[stopped: repeated the same tool call with no progress — the run was looping]"

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/** The longest decoder report, or tool name, the malformed corrective quotes. */
const CORRECTIVE_QUOTE_CHARS = 600

/** What the model can call now, and how to answer, closing each corrective of a malformed reply. */
const replyAgain = (tools: ReadonlyArray<string>): string => tools.length === 0
  ? "You can call no tools now: reply in plain text."
  : `The tools you can call are: ${tools.join(", ")}. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.`

/**
 * The loop's own corrective after a reply the model could not form: a host
 * note saying what was wrong and what it can call, then, for a tool it does
 * not have (the response decodes with any tool name, and the loop reports
 * one the step does not have as `ToolNotFoundError`) or parameters that do
 * not match, what it wrote, framed as data and clipped. A reply that could
 * not be decoded (`InvalidOutputError`: mostly a tool call's arguments that
 * are not valid JSON, else a part of the response that does not parse; the
 * loop reports an unknown tool or parameters that do not match itself) is
 * not quoted: the report on it is the provider's or a dump of the response
 * schema, not the model's words.
 */
const malformedCorrective = (reason: MalformedResponse["reason"], tools: ReadonlyArray<string>): string => Match.valueTags(reason, {
  ToolNotFoundError: (notFound) => `${hostNote(`your previous reply called a tool you do not have; its name follows, as you wrote it. ${replyAgain(tools)}`)}\n\n${framed("tool-name", clipTo(notFound.toolName, CORRECTIVE_QUOTE_CHARS))}`,
  ToolParameterValidationError: (invalid) => `${hostNote(`your previous reply called ${invalid.toolName} with parameters that do not match its schema; what did not match follows, and it may quote your reply. ${replyAgain(tools)}`)}\n\n${framed("parameter-errors", clipTo(invalid.description, CORRECTIVE_QUOTE_CHARS))}`,
  InvalidOutputError: (invalid) => invalid.description === DUPLICATE_CALL_IDS ? duplicateCallCorrective(tools)
    : hostNote(`your previous reply could not be decoded, which usually means a tool call's arguments were not valid JSON. ${replyAgain(tools)}`),
})

/** The loop's own note after a stop that left the host's required work undone. */
const INCOMPLETE_CORRECTIVE = hostNote(
  "the host reports that the required work is not complete, so a reply in text does not finish this turn. " +
  "Complete it with the tools you can call; if it cannot be completed, use one of them that reports why, when there is one.",
)

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

/** @public */
export type Phase = "continue" | "completed" | "step-cap" | "degenerate-loop" | "waiting"

/**
 * The degenerate-loop breaker's fold over one turn's progress signature —
 * PURE, so the default nudge-at-3 / break-at-5 and host policies are tested
 * without a scripted model. An empty signature (no tool calls, or only pollable ones) leaves
 * the count untouched: a turn that did nothing is not a turn that repeated.
 *
 * @public
 */
export const foldProgress = (
  state: { readonly seen: ReadonlySet<string>; readonly staleTurns: number },
  sig: string,
  policy: DegeneratePolicy = defaultDegenerate,
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
    ...Match.valueTags(policy, {
      Disabled: () => ({ nudge: false, broke: false }),
      Enabled: (enabled) => ({ nudge: sig !== "" && stale === enabled.nudgeAfter, broke: sig !== "" && stale >= enabled.breakAfter }),
    }),
  }
}

/** THE decision after a turn — the only model-driven edge is `wantsMore`
 *  (the provider said "tool-calls" and there were some, or "pause"); the
 *  breaker and the cap are the harness's, and they outrank it in that order.
 *
 * @public
 */
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
  /**
   * The run's text a continuation has not finished yet: a reply in text cut
   * at the output limit and asked to continue, or a paused one the run goes
   * on from. The next step that ends it puts it before its own text in
   * `finalText` (`settledText`).
   */
  readonly carried: string
  readonly turnIndex: number
  /** Consecutive malformed responses, each answered with a corrective; any response that is not resets it. */
  readonly malformedStreak: number
  /** Consecutive responses cut at the output limit, each answered with a corrective; any response that is not resets it. */
  readonly cutStreak: number
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

/** The run's text after a step that ends a continuation: the carried text, then the step's; the previous text when both are empty. */
const settledText = (state: LoopState, text: string): Pick<LoopState, "finalText" | "carried"> => {
  const whole = `${state.carried}${text}`
  return { finalText: whole.length > 0 ? whole : state.finalText, carried: "" }
}

/** The run's text after a step the next one continues (a reply in text cut at the output limit, a paused one): carried, not final yet. */
const carriedText = (state: LoopState, text: string): Pick<LoopState, "finalText" | "carried"> =>
  ({ finalText: state.finalText, carried: `${state.carried}${text}` })

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

/**
 * One tool call run through the step's toolkit, under its own span
 * (`loop.tool_call`, a child of the step's): its stream drained here,
 * preliminary results dropped, its last result parted as the toolkit's own
 * resolution parts it. effect/ai's toolkit annotates the span current where
 * a call is handled with the call's `tool` and `parameters`: that is the
 * call's own span, so no call's overwrites another's, and the step's span
 * carries content only with `captureTraceContent`.
 */
const runCall = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.WithHandler<Tools>, call: Response.ToolCallPart<string, unknown>): Effect.Effect<Response.AnyPart, AiError.AiError> =>
  // Erased as the model call is: handlers carry their own context, and fail as the provider's errors do.
  (toolkit.handle(call.name as never, call.params as never, call.id) as Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, AiError.AiError>, AiError.AiError>).pipe(
    Effect.flatMap((results) => Stream.runLast(Stream.filter(results, (result) => !result.preliminary))),
    Effect.flatMap(Option.match({
      onNone: () => Effect.die(new Error(`the tool ${call.name} ended without a result`)),
      onSome: Effect.succeed,
    })),
    Effect.map((result): Response.AnyPart => Response.makePart("tool-result", {
      id: call.id, name: call.name, providerExecuted: false, preliminary: false,
      result: result.result, encodedResult: result.encodedResult, isFailure: result.isFailure,
      ...(result.modelOutput === undefined ? {} : { modelOutput: result.modelOutput }),
    })),
    // Around the handle and the drain: the handler's fiber, forked in the handle, nests its spans under this one.
    Effect.withSpan("loop.tool_call", { attributes: { "engine.tool": call.name, "engine.tool.call_id": call.id } }),
  )

/** The answer to a tool call of a response cut short: it did not run (`replyCutFailure`). */
const cutResult = (call: Response.ToolCallPart<string, unknown>, reason: CutReason): Response.AnyPart => {
  const failure = replyCutFailure(reason)
  return Response.makePart("tool-result", {
    id: call.id, name: call.name, providerExecuted: false, preliminary: false,
    result: failure, encodedResult: failure, isFailure: true,
  })
}

/** @public */
export const runLoop = <Tools extends Record<string, Tool.Any>, E = never, R = never>(
  options: RunLoopOptions<Tools, E, R>,
) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "engine.input.messages": options.messages.length })
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    const policy = yield* Schema.decodeUnknownEffect(loopPolicy)({
      degenerate: options.degenerate ?? defaultDegenerate, malformedLimit: options.malformedLimit ?? DEFAULT_MALFORMED_LIMIT,
    }).pipe(Effect.mapError((cause) => harnessError("config.options", "Loop policy limits are invalid", cause)))
    const pollable: ReadonlySet<string> = new Set(options.pollableTools ?? [])
    const captureTraceContent = options.captureTraceContent ?? (yield* Effect.service(CurrentTraceContent))
    // The callbacks run with the caller's services except its step and tolerance (this loop's own win), under the span current where they are called.
    const eventContext = Context.omit(CurrentAgentRun, CurrentAgentStep, CurrentEmptyResponseTolerance, CurrentToolResultReceipt)(replayableContext(yield* Effect.context<R>()))
    const onEvent = (event: LoopEvent) => withToolResultReceiptGuard(Effect.suspend(() => options.onEvent?.(event) ?? Effect.void).pipe(Effect.provide(eventContext)))
    // Resolve the toolkit's handlers once — they're stable across turns.
    const toolkit = yield* options.toolkit

    /**
     * A step's execution: its call, its tools and its tail, recorded under
     * it. Its exit is the step's status (`onStepSettled`); a response that
     * does not decode comes back `Malformed`, for the loop to answer.
     */
    const beginStep = (state: LoopState) => Effect.gen(function* () {
      yield* onEvent({ type: "turn_start", turnIndex: state.turnIndex })
      const active: ReadonlyArray<string> = options.activeTools === undefined ? Object.keys(toolkit.tools)
        : (yield* options.activeTools().pipe(Effect.provide(eventContext))).map(String)
      const steering = options.durableInput === undefined ? [] : yield* options.durableInput.take(state.turnIndex).pipe(Effect.provide(eventContext))
      return {
        active,
        state: steering.length === 0 ? state : { ...state, messages: [...state.messages, ...steering], newTail: [...state.newTail, ...steering] },
      }
    })

    const execute = (state: LoopState, active: ReadonlyArray<string>) =>
      Effect.gen(function* () {
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
        // `onMediaRejected` dealt with the images. Once a part arrived, deltas went out, so a refusal
        // then fails the step like any other failure after the first part.
        const partSeen = yield* Ref.make(false)
        const attemptState = yield* Ref.make(initialAttempt(state.streamingHealthy))
        // Callback errors share E with provider errors; retain their origin so
        // even a callback's AiError cannot be mistaken for a retryable call.
        const callbackFailure = yield* Ref.make(Option.none<E>())
        const guardedCallback = <A>(callback: Effect.Effect<A, E>) => callback.pipe(Effect.tapError((error) => Ref.set(callbackFailure, Option.some(error))))
        // The step's tools, run by the loop once its response is whole (never by the model call), each
        // between its tool_start and tool_end events.
        const toolSequence = yield* Ref.make(0)
        const instrumented: Toolkit.WithHandler<Tools> = {
          tools: selectedTools,
          handle: (name, params, providerCallId, parseOptions) => Effect.gen(function* () {
            const sequence = yield* Ref.getAndUpdate(toolSequence, (value) => value + 1)
            const toolCallId = `execution:${state.turnIndex}:${sequence}`
            yield* onEvent({ type: "tool_start", turnIndex: state.turnIndex, toolCallId, toolName: String(name), args: params })
            const results = yield* toolkit.handle(name, params, providerCallId, parseOptions)
            return results.pipe(
              // Parameters the toolkit does not decode (the loop decoded them first: a toolkit's own parse
              // options may still refuse them) fail the step whatever the tool's failure mode.
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
        const attempt = Effect.gen(function* () {
          yield* Ref.set(partSeen, false)
          const visible = options.render === undefined ? state.messages : yield* guardedCallback(options.render(stepView).pipe(Effect.provide(eventContext)))
          const prompt = freezeModelRequest(Prompt.concat(instructions, Prompt.make(toPromptMessages(visible))))

          if (captureTraceContent)
            yield* Effect.annotateCurrentSpan({
              "engine.step.input": tracedJson({ messages: prompt.content, activeTools: toolNames }),
            })

          // Tool call resolution is the loop's: the model call returns the response whole, its calls
          // unrun and unvalidated (`deferred`), for the loop to check every one before any runs.
          const callOptions = Object.freeze({
            prompt,
            toolkit: instrumented,
            disableToolCallResolution: true as const,
            toolCallValidation: "deferred" as const,
            ...Option.match(directive, { onNone: () => ({}), onSome: (toolChoice) => ({ toolChoice: toolChoice as never }) }),
          })

          const dispatchModel = Option.isSome(prepared) ? prepared.value.model : yield* LanguageModel.LanguageModel
          const beforeDispatch = options.beforeDispatch === undefined ? Effect.void : guardedCallback(options.beforeDispatch(state.turnIndex, {
            prompt, tools: Object.values(selectedTools), toolChoice: Option.getOrElse(directive, () => "auto"), model: dispatchModel,
          }).pipe(Effect.provide(eventContext)))

          /** Both paths land on the SAME settled shape — after this point the
           *  turn body is identical code, streamed or not. */
          // Tools declare no dependencies (handlers carry their own context), so a
          // model call needs the model alone; `Tool.Any` would widen it to `any`.
          // It fails with the provider's error, or with the caller's from the
          // dispatch check and the tool events.
          const generated = (planned ? LanguageModel.generateText(callOptions) : beforeDispatch.pipe(Effect.andThen(Effect.suspend(() =>
            dispatchModel.generateText(callOptions),
          )))) as Effect.Effect<LanguageModel.GenerateTextResponse<Tools, "deferred">, AiError.AiError | E, LanguageModel.LanguageModel>
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
          // one stream_fallback event; after the first part, deltas went out,
          // so failures ride the existing turn handling (no tool has run: the
          // loop runs them once the response is whole).
          // The dispatch check runs first, outside that fallback: a failed
          // check fails the step, it is no stream failure (the fallback's own
          // call is checked again).
          const streamed = Effect.gen(function* () {
            yield* beforeDispatch
            const folded = yield* foldStreamParts(
              (Stream.unwrap(Effect.sync(() => dispatchModel.streamText(callOptions))) as Stream.Stream<Response.AnyPart, AiError.AiError | E, LanguageModel.LanguageModel>).pipe(
                Stream.tap(() => Ref.set(partSeen, true)),
              ),
              (delta) => (delta.delta.length === 0 ? Effect.void : Ref.update(attemptState, visibleAttempt)).pipe(Effect.andThen(guardedCallback(onEvent({
                  type: "assistant_delta",
                  turnIndex: state.turnIndex,
                  channel: delta.channel,
                  id: delta.id,
                  delta: delta.delta,
                  ...(delta.toolName === undefined ? {} : { toolName: delta.toolName }),
                })))),
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
              Effect.catch((err) => Effect.gen(function* () {
                const armed = yield* Ref.get(partSeen)
                const callback = yield* Ref.get(callbackFailure)
                return yield* armed || Option.exists(callback, (failure) => failure === err) || isTurnError(err) || isImageRejection(err) || isPermanentModelFailure(err)
                  ? Effect.fail(err) : Effect.succeed(Result.fail(failureText(err)))
              })),
              Effect.catchDefect((defect) =>
                Ref.get(partSeen).pipe(
                  Effect.flatMap((armed) =>
                    armed || isTurnError(defect) ? Effect.die(defect) : Effect.succeed(Result.fail(failureText(defect))),
                  ),
                ),
              ),
            )
            return yield* Result.match(folded, {
              onSuccess: Effect.succeed,
              onFailure: (failure) => Ref.update(attemptState, settledAttempt).pipe(Effect.andThen(Effect.logWarning(
                  "streaming failed before any part arrived — falling back to generateText for this run",
                )),
                  Effect.andThen(guardedCallback(onEvent({ type: "stream_fallback", turnIndex: state.turnIndex, message: failure.slice(0, FALLBACK_MESSAGE_CHARS) }))),
                  Effect.andThen(Metric.update(tagged(engineCorrections, { "engine.kind": "stream-fallback" }), 1)),
                  Effect.andThen(settled(false)),
                ),
            })
          })

          const initial = Effect.gen(function* () {
            const provider = yield* LanguageModel.make({
              generateText: ({ span }) => Effect.sync(() => {
                span.attribute("efferent.inference.synthetic", true)
                return [...(options.initialStep ?? []).map((call, index) => ({
                type: "tool-call" as const, id: options.run === undefined ? `planned:0:${index}` : plannedCallIdOf(options.run, index), name: call.name,
                params: call.params, providerExecuted: false,
              })), { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: {}, outputTokens: {} } }]
              }),
              streamText: () => Stream.empty,
            })
            yield* Effect.annotateCurrentSpan("engine.step.host_planned", true)
            return yield* settled(state.streamingHealthy).pipe(Effect.provideService(LanguageModel.LanguageModel, provider))
          })
          const streamable = (yield* Ref.get(attemptState))._tag === "Streamable"
          const useStreaming = options.streaming === true && streamable
          return yield* (planned ? initial : useStreaming ? streamed : settled(streamable))
        })
        type Attempted = Effect.Success<typeof attempt>
        const send: Effect.Effect<Attempted, AiError.AiError | E | HarnessError, LanguageModel.LanguageModel> = Effect.suspend(() => attempt.pipe(
          Effect.result,
          Effect.flatMap((result) => {
            const overflow = (error: AiError.AiError | E | HarnessError, source: unknown): Effect.Effect<Attempted, AiError.AiError | E | HarnessError, LanguageModel.LanguageModel> => Effect.gen(function* () {
              const hook = options.onContextOverflow
              if (planned || hook === undefined || !(yield* Ref.modify(attemptState, (current) => claimRecovery(current, "overflow")))) return yield* Effect.fail(error)
              const evidence = modelOverflowEvidenceOf(source)
              const retry = yield* guardedCallback(hook(state.turnIndex, ...Option.toArray(evidence)).pipe(Effect.provide(eventContext)))
              return yield* retry ? send : Effect.fail(error)
            })
            return Result.match(result, {
              onSuccess: (value) => Option.contains(modelFailureOf(value.content), "ContextOverflow")
                ? overflow(harnessError("model.context-overflow", modelFailureMessageOf("ContextOverflow"), value), value.content)
                : Effect.succeed(value),
              onFailure: (error) => Effect.gen(function* () {
                if (isTurnError(error) || Option.exists(yield* Ref.get(callbackFailure), (failure) => failure === error)) return yield* Effect.fail(error)
                if (Option.contains(modelFailureOf(error), "ContextOverflow")) return yield* overflow(error, error)
                const hook = options.onMediaRejected
                if (planned || (yield* Ref.get(partSeen)) || hook === undefined || !isImageRejection(error)
                  || !(yield* Ref.modify(attemptState, (current) => claimRecovery(current, "media")))) return yield* Effect.fail(error)
                const retry = yield* guardedCallback(hook(clip(error.reason.message, 600)).pipe(Effect.provide(eventContext)))
                return yield* retry ? Effect.logWarning(`the provider refused an image; sending the step again with its images as labels: ${clip(error.reason.message, 300)}`).pipe(
                  Effect.andThen(Metric.update(tagged(engineCorrections, { "engine.kind": "media-rejected" }), 1)), Effect.andThen(send),
                ) : Effect.fail(error)
              }),
            })
          }),
        ))
        const outcome = yield* send.pipe(
          Effect.catch((err) => Ref.get(callbackFailure).pipe(Effect.flatMap((callback) =>
            !Option.exists(callback, (failure) => failure === err) && isMalformed(err)
              ? Effect.succeed({ _tag: "malformed" as const, err: err as MalformedResponse })
              : Effect.fail(err),
          ))),
          // Once the run has tool calls, a following empty response is the
          // model saying "done" — adapters must return it (the fold below
          // ends the turn) instead of rejecting it into the patient outage
          // ladder, which parks the turn until a deadline kills it.
          Effect.provideService(CurrentEmptyResponseTolerance, state.toolCalls > 0),
        )

        // A response that doesn't decode (a part that does not parse: the model
        // call's decoder refuses it) settles the step `malformed`, and the loop
        // answers it (`recover`); nothing ran.
        if (outcome._tag === "malformed") return { _tag: "Malformed" as const, err: outcome.err, toolNames }

        const failed = modelFailureOf(outcome.content)
        if (Option.isSome(failed)) return yield* Effect.fail(harnessError(modelFailureCodeOf(failed.value), modelFailureMessageOf(failed.value), outcome))

        // Mint deterministic ids for id-less tool calls BEFORE anything runs or
        // fans out into events and persisted messages: the results answer them,
        // and UIs key on them (durable identity).
        const response = withToolCallIds(outcome.content, state.turnIndex, options.run)
        // The calls the loop runs: a provider-executed one is the provider's, run and answered there.
        const calls = response.flatMap((part) => part.type === "tool-call" && part.providerExecuted !== true ? [part] : [])
        const verdict = verdictOf(outcome.finishReason, calls.length > 0)
        // A whole response runs its calls only once every one names a tool the step has and its
        // parameters decode: one that does not is a malformed response, and none of them ran.
        const malformed = verdict._tag === "Whole" ? yield* malformedCall(calls, selectedTools) : Option.none()
        if (Option.isSome(malformed)) {
          const reason = Match.valueTags(malformed.value, {
            NotFound: (missing) => new AiError.ToolNotFoundError({ toolName: missing.toolName, availableTools: toolNames }),
            Invalid: (invalid) => new AiError.ToolParameterValidationError({ toolName: invalid.toolName, description: invalid.description }),
            DuplicateId: () => new AiError.InvalidOutputError({ description: DUPLICATE_CALL_IDS }),
          })
          return { _tag: "Malformed" as const, err: AiError.make({ module: "AgentLoop", method: "resolveToolCalls", reason }) as MalformedResponse, toolNames }
        }
        // Store the assistant's complete request before any handler can run. Provider-executed
        // results stay inside that message. A killed process leaves the exact pending calls.
        const usage = extractUsage(outcome.usage, response)
        const model = responseModelOf(response)
        const responseTail = planned ? responseToAgentMessages(response) : withUsageOnAssistant(responseToAgentMessages(response), usage, model)
        const positions = yield* (planned
          ? options.onTail?.(responseTail, state.turnIndex)
          : options.onTail?.(responseTail, state.turnIndex, acceptedModelInputOf(outcome.usage, response))) ?? Effect.succeed([])
        const assistantAt = responseTail.findIndex((message) => message.role === "assistant")
        const assistantPosition = assistantAt >= 0 ? Option.fromNullishOr(positions[assistantAt]) : Option.none<number>()
        const text = responseText(response)
        const toolCalls = responseToolCalls(response)
        yield* onEvent({
          type: "assistant_message", turnIndex: state.turnIndex, text, reasoning: responseReasoning(response),
          toolCalls, usage, finishReason: outcome.finishReason,
          ...Option.match(model, { onNone: () => ({}), onSome: (id) => ({ model: id }) }),
          ...Option.match(assistantPosition, { onNone: () => ({}), onSome: (position) => ({ position }) }),
        })
        // Persist each final result as soon as it returns, while sibling calls may still be running.
        // The returned array keeps call order for the standalone loop's buffer and decisions.
        const recordResult = (part: Response.AnyPart) =>
          (options.onTail?.(responseToAgentMessages([part]), state.turnIndex) ?? Effect.succeed([])).pipe(Effect.as(part))
        const invoke = (call: Response.ToolCallPart<string, unknown>) => Effect.gen(function* () {
          const receipt = yield* makeToolResultReceipt({ tool: call.name, toolCallId: ToolCallId.make(call.id), run: yield* CurrentAgentRun, step: state.turnIndex })
          return yield* runCall(instrumented, call).pipe(
            Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Offer", offer: receipt.offer })),
            Effect.flatMap((part) => recordResult(part).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))),
            Effect.ensuring(receipt.close),
          )
        })
        const results = yield* Match.valueTags(verdict, {
          Whole: () => Effect.forEach(calls, invoke, { concurrency: options.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY }),
          Cut: (cut) => Effect.forEach(calls, (call) => recordResult(cutResult(call, cut.reason)), { concurrency: 1 }),
        })
        const cut = verdict._tag === "Cut" ? Option.some(verdict.reason) : Option.none<CutReason>()
        const content: ReadonlyArray<Response.AnyPart> = [...response, ...results]
        yield* Effect.annotateCurrentSpan({
          "engine.step.finish_reason": outcome.finishReason,
          "engine.step.usage_available": !planned,
          ...(!planned ? { "engine.step.usage": JSON.stringify(usage), ...stepUsageAttributes(usage) } : {}),
          ...(captureTraceContent
            ? { "engine.step.output": tracedJson({ content, usage, finishReason: outcome.finishReason }) }
            : {}),
        })
        const tail = planned ? responseToAgentMessages(content) : withUsageOnAssistant(responseToAgentMessages(content), usage, model)
        const toolResults = responseToolResults(content)
        // Calls that ran: a cut response's were answered, not run.
        yield* Option.isSome(cut) ? Effect.void : Effect.forEach(toolResults, (tr) => Metric.update(tagged(engineToolCalls, {
          "engine.tool": tr.toolName, "engine.ok": tr.ok ? "true" : "false",
        }), 1), { concurrency: 1 })
        return {
          _tag: "Responded" as const,
          content, finishReason: outcome.finishReason, cut, usage, tail, text, toolCalls, toolResults, planned,
          // Whether the response held calls the loop runs (a cut one's were answered instead).
          callsToRun: calls.length > 0,
          streamingHealthy: outcome.streamingHealthy,
        }
      })

    type Executed = Effect.Success<ReturnType<typeof execute>>
    type Malformed = Extract<Executed, { readonly _tag: "Malformed" }>
    type Responded = Extract<Executed, { readonly _tag: "Responded" }>

    /** The step's status: its execution's exit, nothing decided after it. */
    const statusOf = (exit: Exit.Exit<Executed, unknown>): StepStatus => Exit.match(exit, {
      onSuccess: (executed): StepStatus => executed._tag === "Malformed" ? "malformed" : Option.isSome(executed.cut) ? "truncated" : "completed",
      onFailure: (cause): StepStatus => Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed",
    })
    const settle = (step: number, status: StepStatus) =>
      (options.onStepSettled?.(step, status) ?? Effect.void).pipe(Effect.andThen(onEvent({ type: "turn_end", turnIndex: step, status })))

    /**
     * After a malformed step: feed the decode error back as a corrective
     * turn and retry, bounded. The corrective is what the next step reads,
     * so it is recorded under that step, and only when that step runs. A
     * malformed response is no cut one: the count of cuts in a row restarts.
     */
    const recover = (state: LoopState, malformed: Malformed) => Effect.gen(function* () {
      yield* options.durableInput?.pending().pipe(Effect.provide(eventContext)) ?? Effect.succeed(false)
      const streak = state.malformedStreak + 1
      if (streak >= policy.malformedLimit) return yield* Effect.fail(malformed.err)
      // A corrective turn is a turn: the step cap counts it too, so a
      // malformed streak can never carry a run past its ceiling.
      const recoveredIndex = state.turnIndex + 1
      if (recoveredIndex >= maxSteps) {
        yield* Effect.logWarning(`step cap reached while recovering from a malformed response`)
        // The run ends here: the text a continuation carried is its text.
        return { ...state, ...settledText(state, ""), turnIndex: recoveredIndex, malformedStreak: streak, cutStreak: 0, phase: "step-cap" } satisfies LoopState
      }
      const reason = malformed.err.reason
      const desc = clipTo("description" in reason ? reason.description : reason.message, CORRECTIVE_QUOTE_CHARS)
      yield* Effect.logWarning(`recovering from a malformed response: ${desc}`)
      yield* Metric.update(tagged(engineCorrections, { "engine.kind": "malformed" }), 1)
      const corrective: AgentMessage = {
        role: "user",
        content: options.correctives?.malformed?.(malformed.toolNames, desc) ?? malformedCorrective(reason, malformed.toolNames),
      }
      yield* options.onTail?.([corrective], recoveredIndex) ?? Effect.void
      return {
        ...state,
        messages: [...state.messages, corrective],
        newTail: [...state.newTail, corrective],
        turnIndex: recoveredIndex,
        malformedStreak: streak,
        cutStreak: 0,
        corrections: state.corrections + 1,
      } satisfies LoopState
    })

    /**
     * The next step's input, once the run goes on to it: the buffer with the
     * settled step's tail and the loop's own messages for the next step
     * (`appended`, each already recorded under it), folded when `compact`
     * plans it over that buffer and the settled step's usage, then the
     * host's steer, recorded under the next step. Both are consulted only
     * while the run continues, at turn boundaries.
     */
    const nextInput = (state: LoopState, tail: ReadonlyArray<AgentMessage>, appended: ReadonlyArray<AgentMessage>, usage: TokenUsage) => Effect.gen(function* () {
      // --- Within-run compaction ---
      // The buffer rewrite is load-side (persisted history and `newTail`
      // untouched). A plan that violates the assistant-boundary contract is
      // ignored, never applied.
      const nextMessages = [...state.messages, ...tail, ...appended]
      const plan = options.compact === undefined ? Option.none<CompactionPlan>() : yield* options.compact(nextMessages, usage)
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

      // --- Mid-turn steering ---
      // Consulted AFTER the fold so a steering message can never be
      // compacted away before the model sees it.
      const steered = options.pendingInput === undefined ? Option.none<string>() : yield* options.pendingInput()
      const steerTail: ReadonlyArray<AgentMessage> = Option.match(steered, {
        onNone: () => [],
        onSome: (text) => [{ role: "user", content: text }],
      })
      yield* steerTail.length > 0 ? (options.onTail?.(steerTail, state.turnIndex + 1) ?? Effect.void) : Effect.void

      return {
        messages: [
          ...Option.match(applied, {
            onNone: () => nextMessages,
            onSome: (p) => [handoffToMessage(p.summary), ...nextMessages.slice(p.keepFrom)],
          }),
          ...steerTail,
        ],
        newTail: [...state.newTail, ...tail, ...appended, ...steerTail],
      } satisfies Pick<LoopState, "messages" | "newTail">
    })

    /**
     * After a step whose response was cut short (`truncated`): it is in the
     * tail, its calls answered as cut and none of them run. A reply cut at
     * the output limit is answered with a corrective, at most
     * `MAX_CUT_CORRECTIVES` in a row, recorded under the next step and only
     * when that step runs, then the next step's input is made as after any
     * step (`nextInput`: compaction, steering); any other cut, or one more,
     * fails the run with `loop.truncated`. No completion is evaluated for
     * it. A cut response is no malformed one: the count of malformed
     * responses in a row restarts. A reply in text is carried, for the next
     * one to continue; one that held calls the loop would have run is
     * replied to anew.
     */
    const recut = (state: LoopState, responded: Responded, reason: CutReason) => Effect.gen(function* () {
      yield* options.durableInput?.pending().pipe(Effect.provide(eventContext)) ?? Effect.succeed(false)
      const streak = state.cutStreak + 1
      if (reason !== "length" || streak > MAX_CUT_CORRECTIVES) {
        return yield* Effect.fail(harnessError("loop.truncated", truncatedMessage(reason, state.turnIndex, streak)))
      }
      const turnIndex = state.turnIndex + 1
      const answered = {
        ...state,
        turnIndex,
        malformedStreak: 0,
        cutStreak: streak,
        usage: addUsage(state.usage, responded.usage),
        lastUsage: responded.planned ? state.lastUsage : Option.some(responded.usage),
        streamingHealthy: responded.streamingHealthy,
      } satisfies LoopState
      if (turnIndex >= maxSteps) {
        yield* Effect.logWarning("step cap reached while answering a reply cut at the output limit")
        // The run ends here, with no corrective: the carried text and this reply's are its text.
        return {
          ...answered,
          ...settledText(state, responded.text),
          messages: [...state.messages, ...responded.tail],
          newTail: [...state.newTail, ...responded.tail],
          phase: "step-cap",
        } satisfies LoopState
      }
      yield* Effect.logWarning(`answering a reply cut at the output limit (${streak} in a row)`)
      yield* Metric.update(tagged(engineCorrections, { "engine.kind": "reply-cut" }), 1)
      const corrective: AgentMessage = { role: "user", content: lengthCorrective(responded.callsToRun) }
      yield* options.onTail?.([corrective], turnIndex) ?? Effect.void
      const input = yield* nextInput(state, responded.tail, [corrective], responded.usage)
      return {
        ...answered,
        ...input,
        ...(responded.callsToRun ? settledText(state, responded.text) : carriedText(state, responded.text)),
        corrections: state.corrections + 1,
      } satisfies LoopState
    })

    /**
     * After a step that settled with a response: the breaker, completion,
     * compaction and steering. What they append (a nudge, a steer) is the
     * next step's input, recorded under it, and only when the run goes on
     * to that step: a run that ends here (the cap, the breaker, completion)
     * records nothing for a step that never runs. A paused reply the run
     * goes on from is carried; any other puts the carried text before its
     * own in `finalText`.
     */
    const decide = (state: LoopState, responded: Responded) => Effect.gen(function* () {
      const { content, usage, tail, text, toolCalls, toolResults } = responded
      const turnIndex = state.turnIndex + 1

      if (yield* options.waiting?.pipe(Effect.provide(eventContext)) ?? Effect.succeed(false)) return {
        ...state,
        messages: [...state.messages, ...tail],
        newTail: [...state.newTail, ...tail],
        finalText: "",
        carried: "",
        turnIndex,
        usage: addUsage(state.usage, usage),
        lastUsage: responded.planned ? state.lastUsage : Option.some(usage),
        toolCalls: state.toolCalls + toolCalls.length,
        toolFailures: state.toolFailures + toolResults.filter((result) => !result.ok).length,
        streamingHealthy: responded.streamingHealthy,
        phase: "waiting",
      } satisfies LoopState

      // --- Degenerate-loop circuit breaker ---
      // A turn whose progress signature was already seen produced nothing
      // new; count consecutive stale turns, nudge once, then force-stop.
      const sig = progressSignature(content, pollable)
      const progress = foldProgress(state, sig, policy.degenerate)
      const { stale, seen } = progress

      const completed = yield* options.isComplete?.(state.turnIndex) ?? Effect.succeed(false)
      const steered = options.durableInput === undefined ? false : yield* options.durableInput.pending().pipe(Effect.provide(eventContext))
      const requireMore = !completed && options.requireCompletion === true
      // `pause`: the provider paused a long reply, to be continued by the next call.
      const wantsMore = steered || (!completed && (requireMore || (responded.finishReason === "tool-calls" && toolCalls.length > 0) || responded.finishReason === "pause"))
      const broke = progress.broke
      const phase = nextPhase({ broke, wantsMore, turnIndex, maxSteps })
      yield* broke
        ? Effect.logWarning(`breaking a degenerate tool-call loop after ${stale} stale turns`)
        : Effect.void

      // --- The next step's input: a nudge, a completion corrective ---
      const continues = phase === "continue"
      const nudge: ReadonlyArray<AgentMessage> = continues && progress.nudge
        ? [{ role: "user", content: hostNote(DEGENERATE_REPEAT_NUDGE) }]
        : []
      yield* nudge.length > 0 ? (options.onTail?.(nudge, turnIndex) ?? Effect.void) : Effect.void
      yield* nudge.length > 0
        ? Metric.update(tagged(engineCorrections, { "engine.kind": "degenerate-nudge" }), 1)
        : Effect.void
      // A paused reply is no stop: the next call continues it, with no completion corrective between them.
      const completionNudge: ReadonlyArray<AgentMessage> = continues && requireMore && toolCalls.length === 0 && responded.finishReason !== "pause"
        ? [{ role: "user", content: options.correctives?.incomplete ?? INCOMPLETE_CORRECTIVE }]
        : []
      yield* completionNudge.length > 0 ? (options.onTail?.(completionNudge, turnIndex) ?? Effect.void) : Effect.void

      // --- Compaction and steering, only while the run CONTINUES ---
      // A run that ends here appends nothing: a nudge or a completion corrective is due only to a next step.
      const input = continues
        ? yield* nextInput(state, tail, [...nudge, ...completionNudge], usage)
        : { messages: [...state.messages, ...tail], newTail: [...state.newTail, ...tail] }

      // A paused reply the run goes on from is carried, for the next call to continue; any other ends the continuation.
      const texts = continues && responded.finishReason === "pause" ? carriedText(state, text) : settledText(state, text)
      return {
        ...input,
        ...texts,
        finalText: broke && texts.finalText.length === 0 ? DEGENERATE_LOOP_STOP : texts.finalText,
        turnIndex,
        malformedStreak: 0,
        cutStreak: 0,
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
      beginStep(state).pipe(
        Effect.flatMap((begun) => execute(begun.state, begun.active).pipe(Effect.map((executed) => ({ state: begun.state, executed })))),
        Effect.onExit((exit) => settle(state.turnIndex, statusOf(Exit.map(exit, ({ executed }) => executed)))),
        Effect.flatMap(({ state: input, executed }): Effect.Effect<LoopState, AiError.AiError | HarnessError | E, R> => Match.valueTags(executed, {
          Malformed: (malformed) => recover(input, malformed),
          Responded: (responded) => Option.match(responded.cut, {
            onNone: () => decide(input, responded),
            onSome: (reason) => recut(input, responded, reason),
          }),
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
      state.phase === "continue" ? Effect.gen(function* () {
        if (yield* options.waiting?.pipe(Effect.provide(eventContext)) ?? Effect.succeed(false)) return { ...state, finalText: "", phase: "waiting" } as Settled
        return yield* Effect.flatMap(step(state), runSteps)
      }) : Effect.succeed(state as Settled)
    const initial: LoopState = {
        messages: options.messages,
        newTail: [],
        finalText: "",
        carried: "",
        turnIndex: 0,
        malformedStreak: 0,
        cutStreak: 0,
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
      Match.when("waiting", () => ({ outcome: "waiting" as const, reason: "waiting" as const })),
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
      error: outcome === "partial",
    })
    return {
      finalText: final.finalText,
      messages: final.messages,
      newTail: final.newTail,
      outcome,
      reason,
      usage: final.usage,
    } satisfies AgentResult
  }).pipe(Effect.provideService(CurrentAgentRun, Option.fromNullishOr(options.run)), Effect.withSpan("engine.run"))
