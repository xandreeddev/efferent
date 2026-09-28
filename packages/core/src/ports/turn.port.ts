import type { Context, Effect, Layer, Option } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { SkillDefinition } from "../harness/contribution.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { CompletionVerdict } from "../turn/turn-event.entity.js"
import type { InitialBatch, ModelChoice, StepDirective, StepInfo } from "./contribution.port.js"
import type { JournalIO, MemoryReader } from "./memory.port.js"
import type { RunContext } from "./run-context.port.js"
import type { Correctives, LoopLimits, RunResult } from "./step-loop.port.js"
import type { SkillMatch } from "./tool-registry.port.js"
import type { TurnEvents, TurnEventsService, TurnTasks, TurnTasksService } from "./turn-events.port.js"

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
  /** Ask the matcher without writing anything (run it beside other pre-turn work). */
  readonly match: (message: string) => Effect.Effect<SkillMatch, HarnessError>
  /** Activate the always-on skills and a match; recorded as a decision. */
  readonly apply: (match: SkillMatch) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  /** `match` then `apply`. */
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
  /** Record a turn-context message (e.g. the user's intent) the model sees this turn. */
  readonly context: (entry: { readonly id: string; readonly version: string; readonly text: string }) => Effect.Effect<void, HarnessError>
  /** Answer without the loop; still a recorded turn. */
  readonly reply: (text: string) => Effect.Effect<TurnOutcome>
  readonly run: <R = never>(policy: TurnPolicy<R>) => Effect.Effect<RunResult, HarnessError, R>
  /** Wait until every journal write queued so far is stored (e.g. before delivering an answer). */
  readonly flush: Effect.Effect<void, HarnessError>
  /** Run a host store write in journal order and return its result. */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | HarnessError>
}

/** What every turn provides to the host's code, its per-turn layer and its tools. */
export type TurnServices = RunContext | TurnEvents | TurnTasks

/**
 * One admitted turn's input. `layer` is the host's per-turn services (state
 * stores, per-question adapters…): built after RunContext, it is provided to
 * the host's `use`, to the tools, the policy, subscriptions and tasks alike.
 */
export interface TurnInput<A = never, E = never> {
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
  /** The host's per-turn services; its requirements are met by the turn's services. */
  readonly layer?: Layer.Layer<A, E, unknown>
}
