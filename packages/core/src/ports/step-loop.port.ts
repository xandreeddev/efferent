import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { LanguageModel } from "effect/ai"
import type { AgentMessage } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
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
  /** None: the LanguageModel in the turn's services. */
  readonly model: Option.Option<LanguageModel.LanguageModel>
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly toolChoice: Option.Option<ToolChoice>
}

export interface StepRequest {
  readonly tools: RunTools
  /** What the tool handlers run with: the turn's services (its LanguageModel included) and the registry's handlers. */
  readonly handlers: Context.Context<never>
  readonly limits: LoopLimits
  /** A host-planned first batch, run as step zero without a provider call. */
  readonly initial: Option.Option<InitialBatch>
  readonly plan: (step: StepInfo) => Effect.Effect<StepPlan, HarnessError>
  /** Persist a step's appended messages; returns their log entries. */
  readonly record: (step: number, tail: ReadonlyArray<AgentMessage>) => Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  readonly completion: (step: StepInfo) => Effect.Effect<CompletionVerdict, HarnessError>
  readonly steering: Effect.Effect<Option.Option<string>, HarnessError>
  readonly correctives: Option.Option<Correctives>
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  readonly cacheKey: Option.Option<string>
}

export interface RunResult {
  readonly outcome: "completed" | "partial"
  readonly reason: "completed" | "step-cap" | "degenerate-loop"
  readonly text: string
  readonly steps: number
}

/**
 * THE step loop: iterate provider steps until the model stops, the
 * completion verdict holds, or a limit is hit. Contract (see
 * `stepLoopConformance`): per step `step.started` < `tool.*` < `step.ended`
 * (after the tail is recorded) < `completion.evaluated`; a planned batch
 * makes no provider call; a forced tool choice is honoured; a verdict
 * awaiting tasks joins them and is evaluated once more; no provider call
 * follows a complete verdict.
 */
export class StepLoop extends Context.Service<StepLoop, {
  readonly id: string
  readonly version: string
  readonly run: (request: StepRequest) => Effect.Effect<RunResult, HarnessError>
}>()("efferent/StepLoop") {}
