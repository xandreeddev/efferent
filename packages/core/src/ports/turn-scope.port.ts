import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { RunOrdinal, RunRef } from "../domain/run.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { MemoryReader, MemorySession } from "./memory.port.js"
import type { TurnWriter } from "./sessions.port.js"
import type { LoopLimits } from "./step-loop.port.js"
import type { RunTools } from "./tool-registry.port.js"
import type { TurnOutcome } from "./turn.port.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { ModelRequestHeader } from "../turn/model-request.entity.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import type { TurnError } from "../session/sessions.entity.js"

/*
 * The turn as services. `TurnLive(input)` provides them, with RunContext,
 * TurnEvents and TurnTasks, for one admitted turn; the lifecycle
 * (`persistMessage`, `openTurnTools`, `runTurnLoop`, `guardTurn`) is
 * public steps over them, so a host composes the turn it needs and
 * `Agent.turn` is one such composition.
 */

/**
 * A turn-context message the model sees this turn (e.g. the user's intent).
 *
 * @public
 */
export interface TurnContextEntry {
  readonly id: string
  readonly version: string
  readonly text: string
}

/**
 * What storage holds of a turn's requests: what a dispatch is checked
 * against.
 *
 * @public
 */
export interface RequestSnapshot {
  /** The memory entries, in log order (a fork's inherited history first), decoded from the stored memory events. */
  readonly entries: ReadonlyArray<LogEntry>
  /** This run's stored request headers (`request.prepared`), in log order. */
  readonly requests: ReadonlyArray<SessionLogEvent>
  /** Visible request parts and this writer's headers in original logical order; V1-only adapters may omit it. */
  readonly requestEvents?: ReadonlyArray<SessionLogEvent>
}

/** The turn's memory session, and the records that open and close the turn. */
export class TurnMemory extends Context.Service<TurnMemory, MemoryReader & {
  readonly strategy: { readonly id: string; readonly version: string }
  readonly session: MemorySession
  /** Fresh availability probe; an empty final probe leaves later arrivals for the next turn. */
  readonly pendingSteers: Effect.Effect<boolean, TurnError>
  /** Atomically consume waiting steers as exact user messages under this started step before planning its request. */
  readonly steer: (step: number, run: RunOrdinal) => Effect.Effect<ReadonlyArray<AgentMessage>, TurnError>
  /** Record a full materialized header with its required stored parts, then flush before dispatch. */
  readonly prepareRequest: (header: ModelRequestHeader) => Effect.Effect<void, TurnError>
  /**
   * Flush, then read what storage holds, never the memory session's state:
   * the history memory was opened over (read once, at open), visible historical
   * request parts, and this turn's events from its start. Own-tail reads take
   * only events stored after the last one read; inherited sequence numbers do
   * not advance that cursor.
   */
  readonly requestSnapshot: Effect.Effect<RequestSnapshot, TurnError>
  /** The turn's number; fails with `turn.unstarted` before `persistMessage`. */
  readonly number: Effect.Effect<number, HarnessError>
  /**
   * Start a run of the step loop (`stepRequestOf` does, once per run): the
   * turn's run id and number, and the run's ordinal, 0 for the turn's first
   * run and one up for each later one. Its requests, step contexts and step
   * events carry the ordinal, so each run rebuilds its own requests. Fails
   * with `turn.unstarted` before `persistMessage`, and with `turn.closed`
   * once the reply is recorded.
   */
  readonly startRun: Effect.Effect<RunRef, HarnessError>
  /**
   * Record TurnStarted, then publish `turn.started`, and return the turn's
   * number. Once: a second call fails with `turn.persisted`, unless memory
   * failed to record the message, which then waits to be taken again.
   * Anything built before it (a host layer, a matcher's history) sees only
   * earlier turns.
   */
  readonly persistMessage: Effect.Effect<number, TurnError>
  /**
   * Record a TurnContext entry. Before `persistMessage` (a plugin or a host
   * layer built with the turn) it waits, and is recorded right after the
   * message: the turn's entries follow its TurnStarted.
   */
  readonly context: (entry: TurnContextEntry) => Effect.Effect<void, TurnError>
  /**
   * Record TurnEnded, then publish `turn.ended`. Once; a no-op when the
   * message was never persisted. The reply, and what memory records after
   * it, wait for the turn's closing commit (`TurnWriter.closing`): stored
   * with `turn.ended`, never before. A failed outcome after a completed or
   * partial one downgrades the reply held (its id and text kept, nothing
   * published again); any other later call does nothing.
   */
  readonly persistReply: (outcome: TurnOutcome) => Effect.Effect<void, TurnError>
}>()("efferent/TurnMemory") {}

/** The turn's tools: registry-opened once, then shared by the loop, the host and RunContext.activate. */
export class TurnToolbox extends Context.Service<TurnToolbox, {
  /**
   * Open the tools. Once: a second call fails with `tools.opened`, unless
   * the open failed, which leaves them closed to open again. The handlers
   * run with the services of the opener.
   */
  readonly open: Effect.Effect<RunTools, TurnError>
  /** The open tools; fails with `tools.unavailable` before `open`. */
  readonly tools: Effect.Effect<RunTools, HarnessError>
}>()("efferent/TurnToolbox") {}

/**
 * The turn's prompt assembly: the system prompt per variant, and the
 * turn-tier sections. Each section reads the services it declares from the
 * caller's; one the caller lacks fails the render with `requires.missing`.
 */
export class TurnPrompt extends Context.Service<TurnPrompt, {
  /**
   * The system prompt of one variant: the prefix and the static and session
   * sections, rendered once per turn in the caller's services and recorded
   * (SystemPrepared) when it differs from the last one recorded.
   */
  readonly system: (variant: Option.Option<string>) => Effect.Effect<string, TurnError>
  /**
   * Render the turn-tier sections once, as TurnContext entries (later calls,
   * and calls after the reply, do nothing); fails with `turn.unstarted`
   * before `persistMessage`.
   */
  readonly turnSections: Effect.Effect<void, TurnError>
}>()("efferent/TurnPrompt") {}

/** What `TurnLive` builds one turn from. */
export interface TurnLiveInput {
  /** The admitted turn's writer (see `Sessions.begin`): the session, the message, and where everything is stored. */
  readonly turn: TurnWriter
  /** The system prompt prefix, before the contributed sections. */
  readonly system?: string
  /** How deep event reactions may nest before the bus fails the publisher (8). */
  readonly maxEventDepth?: number
}

/** The agent-level defaults of one run; a policy overrides limits and budget. */
export interface TurnRunOptions {
  readonly limits?: Partial<LoopLimits>
  /**
   * The run's token budget when the policy gives none; 64 000 by default. An
   * integer of at least 1 (else the run fails with `turn.budget`): the target
   * memory compaction keeps each request under (system prompt, tool schemas
   * and messages, estimated), not a provider limit. The memory strategy is
   * given the whole budget at the turn's start, and at each step what the
   * system prompt and the active tools' schemas leave of it
   * (`context.budget` when they leave nothing): the window strategy
   * compacts, spills and drops older turns to fit the budget it is given
   * (and fails with `context.budget` when the current turn alone does not),
   * the summary strategy summarizes past its `triggerRatio` of it, and the
   * digester ignores it. Each step's `context.built` records it.
   */
  readonly budgetTokens?: number
  /** The provider prompt-cache key (see `cacheKeyOf`); none by default. */
  readonly cacheKey?: Option.Option<string>
  /** A mid-run user message, consulted between steps. */
  readonly steering?: Effect.Effect<Option.Option<string>, HarnessError>
  /** Durable host-owned yield probe, checked before work and after a settled step. */
  readonly waiting?: Effect.Effect<boolean, TurnError>
  /**
   * Whether the run's spans may carry prompt and response content
   * (`StepRequest.captureTraceContent`) when the policy does not say; when
   * neither does, `CurrentTraceContent` where the run starts (off by default).
   */
  readonly captureTraceContent?: boolean
}
