import { Schema } from "effect"
import type { Effect, Layer, Scope, Stream } from "effect"
import type { LanguageModel } from "effect/ai"
import type {
  Core,
  CoreOptions,
  Inspection,
  KernelEvent,
  Loop,
  LoopFailure,
  Memory,
  Plugin,
  Reply,
  RequestRefused,
  SessionId,
  SessionRefused,
  Sessions,
  Settings,
  Storage,
  StorageError,
  UnknownRecord,
} from "@xandreed/core/kernel"

/** What an agent keeps for its whole life, and a replaced agent hands on: the events, the journals, the sessions. */
export type SharedParts = Core | Storage | Sessions

/** What an agent rebuilds when it is replaced: the settings, the model, memory and the loop. */
export type RebuiltParts = Settings | LanguageModel.LanguageModel | Memory | Loop

/**
 * What an agent is defined with: the model, the system text, and a plugin per contract.
 *
 * @public
 */
export interface AgentConfig {
  /** Effect AI's model layer. */
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  /** The system text, fixed for the agent. */
  readonly system: string
  readonly storage: Plugin<Storage, never, Core>
  /** The stock session plugin when left out. */
  readonly sessions?: Plugin<Sessions, never, Core | Storage>
  readonly memory: Plugin<Memory, never, SharedParts | Settings | LanguageModel.LanguageModel>
  /** The stock loop plugin when left out. */
  readonly loop?: Plugin<Loop, never, SharedParts | Settings | LanguageModel.LanguageModel | Memory>
  /** Anything extra, built after the rest, in this order. */
  readonly plugins?: ReadonlyArray<Plugin<never, never, SharedParts | RebuiltParts>>
  /** How `Core` is set up: the capacity of background delivery. */
  readonly core?: CoreOptions
}

/**
 * What `agent.with` may change. Storage, sessions and `Core` stay the agent's own.
 *
 * @public
 */
export type AgentChanges = Partial<Pick<AgentConfig, "model" | "system" | "memory" | "loop" | "plugins">>

/**
 * What a session is created with, as a host writes it.
 *
 * @public
 */
export interface NewSessionInput {
  readonly owner: string
  readonly parent?: string
}

/**
 * An agent refused a call: the handle was replaced by `with`
 * (`Replaced`), or a session was asked for with an owner or a parent that
 * is no valid one (`InvalidSession`).
 *
 * @public
 */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", {
  reason: Schema.Literals(["Replaced", "InvalidSession"]),
  message: Schema.String,
}) {}

/**
 * What a defined agent is to its host.
 *
 * @public
 */
export interface AgentHandle {
  /** Create a session and return its id: plain data, kept by the host. */
  readonly createSession: (input: NewSessionInput) => Effect.Effect<SessionId, AgentRefused | StorageError>
  /** Run one turn of the session and return its reply. Refused with `Replaced` once `with` replaced this handle. */
  readonly send: (session: SessionId, message: string) => Effect.Effect<Reply, AgentRefused | LoopFailure>
  /** The session as its journal tells it: its state, its events, and every request it sent, resolved. */
  readonly inspect: (session: SessionId) => Effect.Effect<Inspection, StorageError | UnknownRecord | SessionRefused | RequestRefused>
  /** Every event of the agent, live, from the moment the stream is run. */
  readonly events: Stream.Stream<KernelEvent>
  /**
   * Replace this agent by one with the changes, over the same events,
   * storage and sessions. The settings, the model, memory, the loop and the
   * extra plugins are built again, in the scope `with` is called in. This
   * handle refuses `send` from then on; `with` returns once the turns it
   * was running have finished and its own parts are closed, their
   * listeners removed.
   */
  readonly with: (changes: AgentChanges) => Effect.Effect<AgentHandle, AgentRefused, Scope.Scope>
}

/** Whether a handle still takes turns, and how many it is running. */
export const AgentPhase = Schema.Union([
  Schema.TaggedStruct("Live", { running: Schema.Int }),
  Schema.TaggedStruct("Replaced", { running: Schema.Int }),
])
export type AgentPhase = typeof AgentPhase.Type
