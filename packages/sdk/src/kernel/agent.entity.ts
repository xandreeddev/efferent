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
  PluginFailure,
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
  readonly storage: Plugin<Storage, PluginFailure, Core>
  /** The stock session plugin when left out. */
  readonly sessions?: Plugin<Sessions, PluginFailure, Core | Storage>
  readonly memory: Plugin<Memory, PluginFailure, SharedParts | Settings | LanguageModel.LanguageModel>
  /** The stock loop plugin when left out. */
  readonly loop?: Plugin<Loop, PluginFailure, SharedParts | Settings | LanguageModel.LanguageModel | Memory>
  /** Anything extra, built after the rest, in this order. */
  readonly plugins?: ReadonlyArray<Plugin<never, PluginFailure, SharedParts | RebuiltParts>>
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
 * (`Replaced`); a session was asked for with an owner or a parent that is
 * no valid one (`InvalidSession`); a turn was asked for with no message
 * (`EmptyMessage`); or `with` was called from inside a turn of the handle
 * it would replace (`InsideTurn`).
 *
 * @public
 */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", {
  reason: Schema.Literals(["Replaced", "InvalidSession", "EmptyMessage", "InsideTurn"]),
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
  /** Run one turn of the session and return its reply. Refused with `Replaced` once `with` replaced this handle, and with `EmptyMessage` for a message of no text. */
  readonly send: (session: SessionId, message: string) => Effect.Effect<Reply, AgentRefused | LoopFailure>
  /** The session as its journal tells it: its state, its events, and every request it sent, resolved. */
  readonly inspect: (session: SessionId) => Effect.Effect<Inspection, StorageError | UnknownRecord | SessionRefused | RequestRefused>
  /** Every event of the agent, live, from the moment the stream is run. */
  readonly events: Stream.Stream<KernelEvent>
  /**
   * Replace this agent by one with the changes, over the same events,
   * storage and sessions. The settings, the model, memory, the loop and the
   * extra plugins are built again, in the scope `with` is called in, and
   * then the two agents switch in one step: this handle refuses `send` from
   * then on, and the one returned takes over. Until the switch this handle
   * is fully usable: if `with` fails or is interrupted before it, what was
   * built is released and nothing changed. A turn this handle is running
   * finishes on its own parts, which close after it, their listeners
   * removed; with no turn running they are closed when `with` returns.
   * Called from inside a turn of this handle, `with` is refused
   * (`InsideTurn`).
   */
  readonly with: (changes: AgentChanges) => Effect.Effect<AgentHandle, AgentRefused | PluginFailure, Scope.Scope>
}

/** Whether a handle still takes turns, and how many it is running. */
export const AgentPhase = Schema.Union([
  Schema.TaggedStruct("Live", { running: Schema.Int }),
  Schema.TaggedStruct("Replaced", { running: Schema.Int }),
])
export type AgentPhase = typeof AgentPhase.Type
