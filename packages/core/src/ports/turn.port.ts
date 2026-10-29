import type { Context, Effect, Layer, Option, Scope } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { SkillDefinition } from "../harness/capability.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { CompletionVerdict } from "../turn/turn-event.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { InitialBatch, ModelChoice, StepDirective, StepInfo } from "./capability.port.js"
import type { MemoryReader } from "./memory.port.js"
import type { RunContext } from "./run-context.port.js"
import type { TurnWriter } from "./sessions.port.js"
import type { JsonObject } from "../session/session-log.entity.js"
import type { AdmittedTurn, SessionAddress, TurnBeginError, TurnError } from "../session/sessions.entity.js"
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
  /**
   * Read-only by contract: react to events, decide here. The verdict's
   * `awaiting` tags are trimmed and empty ones dropped before the loop awaits
   * them and the journal stores it.
   */
  readonly completion?: (step: StepInfo) => Effect.Effect<CompletionVerdict, HarnessError, R>
  readonly limits?: Partial<LoopLimits>
  /**
   * This run's token budget (an integer of at least 1, else the run fails
   * with `turn.budget`): the target memory compaction keeps each request
   * under, the system prompt, tool schemas and messages estimated together,
   * not a provider limit. The memory strategy is given the whole budget at
   * the turn's start, and at each step what the system prompt and tool
   * schemas leave of it (`context.budget` when they leave nothing): the
   * window strategy compacts, spills and drops older turns to fit the budget
   * it is given (and fails with `context.budget` when the current turn alone
   * does not), the summary strategy summarizes once the messages pass its
   * `triggerRatio` of it and keeps its `keepRatio`, and the digester ignores
   * it. Overrides the agent's `budgetTokens` (64 000 by default).
   */
  readonly budgetTokens?: number
  /** Where the step context goes: closing the messages, or appended to the system prompt. */
  readonly stepContext?: "tail" | "system"
  readonly correctives?: Correctives
  /**
   * Whether this run's spans may carry prompt and response content
   * (`engine.step.input`, `engine.step.output`, the models plugin's
   * `llm.reasoning`). Overrides the agent's `captureTraceContent`; off by
   * default. Hosts own consent, masking and exporter retention.
   */
  readonly captureTraceContent?: boolean
}

export interface TurnOutcome {
  readonly outcome: "completed" | "partial" | "failed"
  /** The reply follow-up turns remember. */
  readonly reply: Option.Option<string>
}

/**
 * What a turn runner returns: the outcome `use` gave, and the turn's usage,
 * the usage of its `assistant.message` events summed (the stored
 * `step.usage` records of the turn sum to the same, see `turnUsageOf`).
 * Calls outside the step loop (a memory digester's or summarizer's utility
 * model) and responses that never decoded are not in it.
 */
export interface TurnResult extends TurnOutcome {
  readonly usage: TokenUsage
  /**
   * How many inbox items wait once the turn's closing commit is stored
   * (`TurnWriter.end`'s `pending`), when the runner ended the turn itself
   * (`Agent.turn` with a `NewTurn`). A result delivered while the turn ran
   * (a background task's) waits for it, and its deliverer's drain found the
   * session busy: the turn's caller, its closer, drains them
   * (`Sessions.drain`). Absent for a turn the host began and ends itself,
   * whose own `end` returns the count.
   */
  readonly pending?: number
}

export interface TurnTools {
  /** Ask the matcher without writing anything (run it beside other pre-turn work). */
  readonly match: (userMessage: UserMessage) => Effect.Effect<SkillMatch, HarnessError>
  /** Activate the always-on skills and a match; recorded as a decision. */
  readonly apply: (match: SkillMatch) => Effect.Effect<ReadonlyArray<string>, TurnError>
  /** `match` then `apply`. */
  readonly select: (userMessage: UserMessage) => Effect.Effect<ReadonlyArray<string>, TurnError>
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, TurnError>
  readonly active: Effect.Effect<ReadonlyArray<string>>
  readonly skills: ReadonlyArray<SkillDefinition>
}

/** One admitted turn, composed by the host (see `Agent.turn`). */
export interface Turn {
  readonly conversation: ConversationId
  readonly runId: string
  readonly turn: number
  readonly userMessage: UserMessage
  /** The admitted turn as the session began it, the host's `meta` included (`RunContext.admitted`). */
  readonly admitted: AdmittedTurn
  readonly memory: MemoryReader
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  readonly tools: TurnTools
  /** Record a turn-context message (e.g. the user's intent) the model sees this turn. */
  readonly context: (entry: { readonly id: string; readonly version: string; readonly text: string }) => Effect.Effect<void, TurnError>
  /** Answer without the loop; still a recorded turn. */
  readonly reply: (text: string) => Effect.Effect<TurnOutcome>
  readonly run: <R = never>(policy: TurnPolicy<R>) => Effect.Effect<RunResult, TurnError, R>
  /** The turn's usage so far, every run of it included (`RunContext.usage`). */
  readonly usage: Effect.Effect<TokenUsage>
  /** Wait until every journal write queued so far is stored (e.g. before delivering an answer). */
  readonly flush: Effect.Effect<void, TurnError>
  /** Run a host store write in journal order and return its result. */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | TurnError>
}

/** What every turn provides to the host's code, its per-turn layer and its tools. */
export type TurnServices = RunContext | TurnEvents | TurnTasks

/** A turn to begin: the session (through the `Sessions` in the turn's services), the message and the run. */
export interface NewTurn {
  readonly session: SessionAddress
  /** The user's message; when resuming, what the model sees after the resumed turn's steps (its own message again, or "Continue."). */
  readonly userMessage: UserMessage
  readonly runId: string
  /** The idempotency key; `resume:<n>` when resuming turn `n`, the run id otherwise. */
  readonly key?: string
  /** The host's input beside the message, part of the key's fingerprint. */
  readonly command?: JsonObject
  /**
   * The host's metadata for the turn (a request id, a tenant…): stored in
   * `turn.started`, shown on `RunContext.admitted`, `Turn.admitted` and the
   * bus `turn.started`, and given to `TurnAdmission`. Not part of the key's
   * fingerprint, and never shown to the model.
   */
  readonly meta?: JsonObject
  /**
   * Resume turn `n`: the session's last turn begun by a user, which ended
   * cancelled or interrupted (only inbox turns, and resumes of it that
   * failed, were cancelled or were interrupted, may have run since);
   * otherwise, or when `n` is not a whole number of at least 1, the turn
   * fails to begin with `NotResumable` (`turn.not-resumable`). Memory is
   * what a plain new turn would see: what turn `n` stored (its message and
   * whole steps), then this turn's message. Stored in `turn.started`, shown
   * on `admitted` and the bus `turn.started`, and part of the key's
   * fingerprint. With the default key `resume:<n>`, a retry is
   * `TurnDuplicate` (`turn.duplicate`) once the resuming turn has begun,
   * however it ended: to try a resume that failed again, pass a new key.
   */
  readonly resumes?: number
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
  /**
   * This turn's services: the model, per-turn budgets, data ports… They may
   * be a captured context: `Agent.turn` provides them without their trace
   * state (`replayableContext`), so a parent span or span annotations among
   * them are ignored (the turn's spans nest under the span where
   * `Agent.turn` is called; wrap that call in `Effect.withParentSpan` for
   * another parent). A `CurrentTraceContent` among them is kept: it is
   * where the turn's runs start, under the agent's and the policy's
   * `captureTraceContent`.
   */
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
 * `turnConformance`). A turn it begins itself and that cannot begin fails
 * with the refusal itself (`TurnBeginError`: `SessionBusy`,
 * `TurnDuplicate`…), before anything runs, so a caller matches it with
 * `Effect.catchTag`; `harnessCodeOf` gives the code it stands for
 * (`turnBeginCodes`).
 */
export interface TurnRunner {
  readonly turn: <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, R>,
  ) => Effect.Effect<TurnResult, TurnBeginError | TurnError | E, Exclude<R, A | TurnServices | Scope.Scope>>
}
