import type { Context, Effect, Option } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { SkillDefinition } from "../harness/contribution.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { CompletionVerdict } from "../turn/turn-event.entity.js"
import type { InitialBatch, ModelChoice, StepDirective, StepInfo } from "./contribution.port.js"
import type { JournalIO, MemoryReader } from "./memory.port.js"
import type { Correctives, LoopLimits, RunResult } from "./step-loop.port.js"
import type { TurnEventsService, TurnTasksService } from "./turn-events.port.js"

/**
 * The host's policy for one run: plain functions, not plugins. The step
 * loop implementation is the plugin; what a step says, which model it uses
 * and when the turn is complete are the application's decisions.
 */
export interface TurnPolicy<R = never> {
  readonly initial?: InitialBatch
  readonly model?: (step: StepInfo) => Effect.Effect<Option.Option<ModelChoice>, HarnessError, R>
  readonly step?: (step: StepInfo) => Effect.Effect<StepDirective, HarnessError, R>
  /** Read-only by contract: react to events, decide here. */
  readonly completion?: (step: StepInfo) => Effect.Effect<CompletionVerdict, HarnessError, R>
  readonly limits?: Partial<LoopLimits>
  /** Input tokens one request may use (system, tool schemas and messages). */
  readonly budgetTokens?: number
  /** Where the step context goes: closing the messages, or appended to the system prompt. */
  readonly stepContext?: "tail" | "system"
  readonly correctives?: Correctives
}

export interface TurnOutcome {
  readonly outcome: "completed" | "partial" | "failed"
  /** The reply follow-up turns remember. */
  readonly reply: Option.Option<string>
}

export interface TurnTools {
  /** Always-on skills plus the matcher's choice (recorded as a decision). */
  readonly select: (message: string) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly active: Effect.Effect<ReadonlyArray<string>>
  readonly skills: ReadonlyArray<SkillDefinition>
}

/** One admitted turn, composed by the host (see `Agent.turn`). */
export interface Turn {
  readonly conversation: ConversationId
  readonly runId: string
  readonly turn: number
  readonly prompt: string
  readonly memory: MemoryReader
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  readonly tools: TurnTools
  /** What tools run with: host services, per-run contribution layers and RunContext. */
  readonly services: Context.Context<never>
  /** Record a turn-context message (e.g. the user's intent) the model sees this turn. */
  readonly context: (entry: { readonly id: string; readonly version: string; readonly text: string }) => Effect.Effect<void, HarnessError>
  /** Answer without the loop; still a recorded turn. */
  readonly reply: (text: string) => Effect.Effect<TurnOutcome>
  readonly run: <R>(policy: TurnPolicy<R>) => Effect.Effect<RunResult, HarnessError, R>
}

export interface TurnInput {
  readonly conversation: ConversationId
  readonly runId: string
  readonly prompt: string
  /** This turn's services: the model, per-turn budgets, data ports… */
  readonly services: Context.Context<never>
  /** The conversation's journal: memory storage, and where every event is persisted. */
  readonly journal: JournalIO
  /** A system prompt prefix before the contributed sections. */
  readonly system?: string
  /** Per-conversation prompt-cache key for providers that support one. */
  readonly cacheKey?: string
  /** A mid-run user message, consulted between steps. */
  readonly steering?: Effect.Effect<Option.Option<string>, HarnessError>
}
