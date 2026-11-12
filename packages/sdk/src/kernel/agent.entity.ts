import { Schema } from "effect"
import type { Effect, Layer, Scope, Stream } from "effect"
import type { LanguageModel } from "effect/ai"
import type {
  CoreOptions,
  Inspection,
  KernelEvent,
  Loop,
  LoopFailure,
  Memory,
  PluginFailure,
  PluginOf,
  PluginRefused,
  Reply,
  RequestRefused,
  SessionId,
  SessionRefused,
  Sessions,
  Storage,
  StorageError,
  UnknownRecord,
} from "@xandreed/core/kernel"

/**
 * What an agent is defined with: the model, the system text, and a plugin
 * per contract. A plugin's slot says what it provides; what it needs it
 * declares (`requires`), and `Agent.define` checks every declaration before
 * it builds anything.
 *
 * The parts come in two stages. Storage and sessions are built once and
 * shared by every agent `with` returns: they may need `Core` and each
 * other. Memory, the loop and the extra plugins are built again by `with`:
 * they may need `Core`, `Settings`, the model, the shared parts and each
 * other.
 *
 * @public
 */
export interface AgentConfig {
  /** Effect AI's model layer. */
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  /** The system text, fixed for the agent. */
  readonly system: string
  readonly storage: PluginOf<Storage>
  /** The stock session plugin when left out. */
  readonly sessions?: PluginOf<Sessions>
  readonly memory: PluginOf<Memory>
  /** The stock loop plugin when left out. */
  readonly loop?: PluginOf<Loop>
  /**
   * Anything extra. One may provide a contract of its own, declared in its
   * own folder, and another, or memory or the loop, may require it. They
   * are built after memory and the loop, in this order, but that a plugin
   * whose contract another part requires is built before that part.
   */
  readonly plugins?: ReadonlyArray<PluginOf>
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
   * (`InsideTurn`). What the changed plugins declare is checked first, as
   * `Agent.define` checks it: a set that does not fit is refused
   * (`PluginRefused`) with nothing built and nothing changed.
   */
  readonly with: (changes: AgentChanges) => Effect.Effect<AgentHandle, AgentRefused | PluginRefused | PluginFailure, Scope.Scope>
}

/** Whether a handle still takes turns, and how many it is running. */
export const AgentPhase = Schema.Union([
  Schema.TaggedStruct("Live", { running: Schema.Int }),
  Schema.TaggedStruct("Replaced", { running: Schema.Int }),
])
export type AgentPhase = typeof AgentPhase.Type
