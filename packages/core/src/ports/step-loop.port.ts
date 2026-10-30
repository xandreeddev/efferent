import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { LanguageModel, Prompt, Tool } from "effect/ai"
import type { AgentMessage } from "../domain/message.entity.js"
import type { RunRef } from "../domain/run.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { TurnError } from "../session/sessions.entity.js"
import type { CompletionVerdict } from "../turn/turn-event.entity.js"
import type { InitialBatch, StepInfo, ToolChoice } from "./capability.port.js"
import type { RunTools } from "./tool-registry.port.js"
import type { TurnEventsService, TurnTasksService } from "./turn-events.port.js"

export interface LoopLimits {
  /** A ceiling, not a target: a run ends when the model stops calling tools. */
  readonly maxSteps: number
  readonly toolConcurrency: number
  readonly streaming: boolean
  /** A model stop does not end the run while the completion verdict is incomplete. */
  readonly requireCompletion: boolean
}

/** Host wording for the loop's own corrective turns. */
export interface Correctives {
  readonly malformed: (tools: ReadonlyArray<string>, description: string) => string
  readonly incomplete: string
}

/** Everything one provider request needs, prepared by the turn. */
export interface StepPlan {
  /** The step's model, resolved once for the step (`resolveModelRequest`); None: the LanguageModel in the turn's services. */
  readonly model: Option.Option<LanguageModel.LanguageModel>
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly toolChoice: Option.Option<ToolChoice>
}

export interface StepRequest {
  /**
   * The run this request is (`TurnMemory.startRun`): the loop puts its
   * ordinal on the step events it publishes (`step.*`, `assistant.message`,
   * `completion.evaluated`, `stream.fallback`) and mints the ids of a
   * provider's id-less tool calls from it (`toolCallIdOf`, and
   * `plannedCallIdOf` for a planned batch), so they differ across the runs
   * and turns of a session.
   */
  readonly run: RunRef
  readonly tools: RunTools
  /** What the tool handlers run with: the turn's services (its LanguageModel included) and the registry's handlers. */
  readonly handlers: Context.Context<never>
  readonly limits: LoopLimits
  /** A host-planned first batch, run as step zero without a provider call. */
  readonly initial: Option.Option<InitialBatch>
  readonly plan: (step: StepInfo) => Effect.Effect<StepPlan, TurnError>
  /**
   * Validate an actual dispatch against a fresh durable derivation. Run immediately before each provider attempt,
   * including a streaming fallback; a failed check fails the step (a streamed step does not fall back).
   */
  readonly dispatch: (step: number, request: ModelDispatch) => Effect.Effect<void, TurnError>
  /**
   * Persist appended messages under `step`; returns their log entries. A
   * step's tail (the response and its tool results) is recorded under that
   * step, before its `step.ended`; the loop's own messages (a corrective, a
   * nudge, a steer) under the next step, which reads them.
   */
  readonly record: (step: number, tail: ReadonlyArray<AgentMessage>) => Effect.Effect<ReadonlyArray<LogEntry>, TurnError>
  /**
   * A provider refused the step's request over an image (an `InvalidRequestError`
   * that names one; `reason` is what it said). Records an `OmitMedia`
   * compaction of the entries whose images that request sent and answers
   * true, so the loop plans the step again and sends it once more, the
   * images as label lines; false when the request sent no image, and the
   * step fails. The step's next `plan`, that one only, keeps the model
   * choice, system prompt and directive the refused request was planned
   * with; any other `plan` of a step asks the policy again.
   */
  readonly onMediaRejected: (reason: string) => Effect.Effect<boolean, TurnError>
  /** The host's verdict after a step that settled with a response (not after a malformed one); its failure fails the run, not the step. */
  readonly completion: (step: StepInfo) => Effect.Effect<CompletionVerdict, HarnessError>
  readonly steering: Effect.Effect<Option.Option<string>, HarnessError>
  readonly correctives: Option.Option<Correctives>
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  readonly cacheKey: Option.Option<string>
  /**
   * Whether the run's spans may carry prompt and response content: the loop
   * must provide it as `CurrentTraceContent` to the model calls it makes,
   * whatever the caller's (`stepLoopConformance` checks it), so they read it
   * too. The policy's `captureTraceContent`, else the agent's, else
   * `CurrentTraceContent` where the run starts (off by default).
   */
  readonly captureTraceContent: boolean
}

export interface ModelDispatch {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly toolChoice: unknown
  readonly model: LanguageModel.LanguageModel
}

/**
 * How a run of the step loop came out: `completed` when the model stopped
 * or the completion verdict held; `partial` when the step cap or the
 * degenerate-loop breaker stopped it, so its `text` is not a deliverable.
 */
export type RunResult = {
  readonly text: string
  readonly steps: number
  /** The run's provider calls summed: exactly the usage its `assistant.message` events carried. */
  readonly usage: TokenUsage
} & (
  | { readonly outcome: "completed"; readonly reason: "completed" }
  | { readonly outcome: "partial"; readonly reason: "step-cap" | "degenerate-loop" }
)

/**
 * THE step loop: iterate provider steps until the model stops, the
 * completion verdict holds, or a limit is hit. Contract (see
 * `stepLoopConformance`): per step `step.started` < `tool.*` < `step.ended`
 * (after the tail is recorded) < `completion.evaluated`; each step that
 * started ends once, with the status of its own call, tools and tail
 * (`completed`, `failed`, `cancelled`, or `malformed` for a response the
 * model could not form, which gets no `completion.evaluated`), so a
 * completion that fails afterwards leaves it `completed`; nothing is
 * recorded under a step after its `step.ended` (the loop's own messages,
 * a corrective, a nudge or a steer, are the next step's), and nothing
 * under a step that never starts (a run the step cap or a complete verdict
 * ends records no corrective or nudge for a next step); a planned batch
 * makes no provider call; a forced tool choice is honoured; a verdict
 * awaiting tasks joins them and is evaluated once more; no provider call
 * follows a complete verdict; `RunResult.usage` is the sum of the usage
 * the run's `assistant.message` events carried; the model calls read the
 * request's `captureTraceContent` as `CurrentTraceContent`; a streamed
 * step's reasoning reaches the next request with its provider metadata, as
 * a non-streamed one's does; the step events carry the request's run
 * ordinal, and id-less tool calls get ids distinct across runs and turns. A loop that streams and falls back to a
 * non-streamed call publishes `stream.fallback`; the kit's streams do not
 * fail, so it does not check that.
 * Every real provider attempt runs `request.dispatch` immediately before
 * invoking the model; a failed durable check prevents the call. Planned
 * batches skip that hook because they make no provider request. A request
 * a provider refuses over an image is sent once more after
 * `request.onMediaRejected` answers true, planned again first.
 */
export class StepLoop extends Context.Service<StepLoop, {
  readonly id: string
  readonly version: string
  readonly run: (request: StepRequest) => Effect.Effect<RunResult, TurnError>
}>()("efferent/StepLoop") {}
