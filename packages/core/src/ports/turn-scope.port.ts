import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { MemoryReader, MemorySession } from "./memory.port.js"
import type { TurnWriter } from "./sessions.port.js"
import type { LoopLimits } from "./step-loop.port.js"
import type { RunTools } from "./tool-registry.port.js"
import type { TurnOutcome } from "./turn.port.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { ModelRequestHeader } from "../turn/model-request.entity.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"

/*
 * The turn as services. `TurnLive(input)` provides them, with RunContext,
 * TurnEvents and TurnTasks, for one admitted turn; the lifecycle
 * (`persistMessage`, `openTurnTools`, `runTurnLoop`, `guardTurn`) is
 * public steps over them, so a host composes the turn it needs and
 * `Agent.turn` is one such composition.
 */

/** A turn-context message the model sees this turn (e.g. the user's intent). */
export interface TurnContextEntry {
  readonly id: string
  readonly version: string
  readonly text: string
}

/** What storage holds of a turn's requests: what a dispatch is checked against. */
export interface RequestSnapshot {
  /** The memory entries, in log order (a fork's inherited history first), decoded from the stored memory events. */
  readonly entries: ReadonlyArray<LogEntry>
  /** This run's stored request headers (`request.prepared`), in log order. */
  readonly requests: ReadonlyArray<SessionLogEvent>
}

/** The turn's memory session, and the records that open and close the turn. */
export class TurnMemory extends Context.Service<TurnMemory, MemoryReader & {
  readonly strategy: { readonly id: string; readonly version: string }
  readonly session: MemorySession
  /** Record and flush a request's reconstruction header before dispatch. */
  readonly prepareRequest: (header: ModelRequestHeader) => Effect.Effect<void, HarnessError>
  /**
   * Flush, then read what storage holds, never the memory session's state:
   * the history memory was opened over (read once, at open), and this
   * turn's events from its start, each read taking only the events stored
   * after the last one read.
   */
  readonly requestSnapshot: Effect.Effect<RequestSnapshot, HarnessError>
  /** The turn's number; fails with `turn.unstarted` before `persistMessage`. */
  readonly number: Effect.Effect<number, HarnessError>
  /**
   * Record TurnStarted, then publish `turn.started`, and return the turn's
   * number. Once: a second call fails. Anything built before it (a host
   * layer, a matcher's history) sees only earlier turns.
   */
  readonly persistMessage: Effect.Effect<number, HarnessError>
  /**
   * Record a TurnContext entry. Before `persistMessage` (a plugin or a host
   * layer built with the turn) it waits, and is recorded right after the
   * message: the turn's entries follow its TurnStarted.
   */
  readonly context: (entry: TurnContextEntry) => Effect.Effect<void, HarnessError>
  /** Record TurnEnded, then publish `turn.ended`. Once; a no-op when the message was never persisted. */
  readonly persistReply: (outcome: TurnOutcome) => Effect.Effect<void, HarnessError>
}>()("efferent/TurnMemory") {}

/** The turn's tools: registry-opened once, then shared by the loop, the host and RunContext.activate. */
export class TurnToolbox extends Context.Service<TurnToolbox, {
  /** Open the tools. Once: a second call fails. The handlers run with the services of the opener. */
  readonly open: Effect.Effect<RunTools, HarnessError>
  /** The open tools; fails with `tools.unavailable` before `open`. */
  readonly tools: Effect.Effect<RunTools, HarnessError>
}>()("efferent/TurnToolbox") {}

/** The turn's prompt assembly: the system prompt per variant, and the turn-tier sections. */
export class TurnPrompt extends Context.Service<TurnPrompt, {
  /**
   * The system prompt of one variant: the prefix and the static and session
   * sections, rendered once per turn in the caller's services and recorded
   * (SystemPrepared) when it differs from the last one recorded.
   */
  readonly system: (variant: Option.Option<string>) => Effect.Effect<string, HarnessError>
  /** Render the turn-tier sections once, as TurnContext entries (later calls do nothing). */
  readonly turnSections: Effect.Effect<void, HarnessError>
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
  /** Input tokens one request may use (system, tool schemas and messages); 64 000 by default. */
  readonly budgetTokens?: number
  /** The provider prompt-cache key (see `cacheKeyOf`); none by default. */
  readonly cacheKey?: Option.Option<string>
  /** A mid-run user message, consulted between steps. */
  readonly steering?: Effect.Effect<Option.Option<string>, HarnessError>
}
