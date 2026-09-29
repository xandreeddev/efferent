import type { Context, Effect, Layer, Option, Scope } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { SkillDefinition } from "../harness/capability.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { CompletionVerdict } from "../turn/turn-event.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { InitialBatch, ModelChoice, StepDirective, StepInfo } from "./capability.port.js"
import type { MemoryReader } from "./memory.port.js"
import type { RunContext } from "./run-context.port.js"
import type { TurnWriter } from "./sessions.port.js"
import type { JsonObject } from "../session/session-log.entity.js"
import type { SessionAddress } from "../session/sessions.entity.js"
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
  readonly match: (userMessage: UserMessage) => Effect.Effect<SkillMatch, HarnessError>
  /** Activate the always-on skills and a match; recorded as a decision. */
  readonly apply: (match: SkillMatch) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  /** `match` then `apply`. */
  readonly select: (userMessage: UserMessage) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly active: Effect.Effect<ReadonlyArray<string>>
  readonly skills: ReadonlyArray<SkillDefinition>
}

/** One admitted turn, composed by the host (see `Agent.turn`). */
export interface Turn {
  readonly conversation: ConversationId
  readonly runId: string
  readonly turn: number
  readonly userMessage: UserMessage
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

/** A turn to begin: the session (through the `Sessions` in the turn's services), the message and the run. */
export interface NewTurn {
  readonly session: SessionAddress
  readonly userMessage: UserMessage
  readonly runId: string
  /** The idempotency key; the run id by default. */
  readonly key?: string
  /** The host's input beside the message, part of the key's fingerprint. */
  readonly command?: JsonObject
}

/**
 * One turn's input. `turn` is either a turn the host already began (its
 * writer: the host ends it) or one to begin and end here. `layer` is the
 * host's per-turn services (state stores, adapters for this user
 * message…): built after RunContext, it is provided to the host's `use`, to
 * the tools, the policy, subscriptions and tasks alike.
 */
export interface TurnInput<A = never, E = never> {
  readonly turn: TurnWriter | NewTurn
  /** This turn's services: the model, per-turn budgets, data ports… */
  readonly services: Context.Context<never>
  /** A system prompt prefix before the contributed sections. */
  readonly system?: string
  /** Per-conversation prompt-cache key for providers that support one. */
  readonly cacheKey?: string
  /** A mid-run user message, consulted between steps. */
  readonly steering?: Effect.Effect<Option.Option<string>, HarnessError>
  /** The host's per-turn services; its requirements are met by the turn's services. */
  readonly layer?: Layer.Layer<A, E, unknown>
}

/**
 * Anything that runs one admitted turn the way `Agent.turn` does: an
 * agent, or a host's own composition of the turn's steps (see
 * `turnConformance`).
 */
export interface TurnRunner {
  readonly turn: <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ) => Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>
}
