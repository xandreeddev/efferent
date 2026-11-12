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
 * (`Replaced`); `with` is replacing it now, so it takes no turn and no
 * second `with` until that one is done or given up (`Replacing`); a session
 * was asked for with an owner or a parent that is no valid one
 * (`InvalidSession`); a turn was asked for with no message
 * (`EmptyMessage`); or `with` was called from inside a turn of the handle
 * it would replace (`InsideTurn`).
 *
 * @public
 */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", {
  reason: Schema.Literals(["Replaced", "Replacing", "InvalidSession", "EmptyMessage", "InsideTurn"]),
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
  /** Run one turn of the session and return its reply. Refused with `Replacing` while `with` is replacing this handle, with `Replaced` once it has, and with `EmptyMessage` for a message of no text. */
  readonly send: (session: SessionId, message: string) => Effect.Effect<Reply, AgentRefused | LoopFailure>
  /** The session as its journal tells it: its state, its events, and every request it sent, resolved. */
  readonly inspect: (session: SessionId) => Effect.Effect<Inspection, StorageError | UnknownRecord | SessionRefused | RequestRefused>
  /** Every event of the agent, live, from the moment the stream is run. */
  readonly events: Stream.Stream<KernelEvent>
  /**
   * Replace this agent by one with the changes, over the same events,
   * storage and sessions, once this one is idle.
   *
   * `with` first marks this handle as being replaced: from then on a `send`
   * on it, and a second `with`, are refused (`Replacing`). It waits for the
   * turns the handle is running to finish, and for every listener to have
   * handled what was published (at most `idleWait`, 5 seconds unless `Core`
   * is set up with another; a listener still running then is reported as
   * `core.listener.failed`). Only then, with nothing running, it builds the
   * settings, the model, memory, the loop and the extra plugins again, in
   * the scope `with` is called in, closes this handle's own parts, their
   * listeners removed, and returns the agent that takes over. So no event
   * of a turn reaches the listeners of both agents, and this one's
   * listeners lose none of its last turn.
   *
   * If `with` fails, because what the changed plugins declare does not fit
   * (`PluginRefused`) or a plugin cannot be built, or is interrupted at any
   * point before the switch, what was built is released and this handle is
   * usable again, as if `with` had not been called. Called from inside a
   * turn of this handle, `with` is refused at once (`InsideTurn`). A change
   * given as `undefined` is no change.
   */
  readonly with: (changes: AgentChanges) => Effect.Effect<AgentHandle, AgentRefused | PluginRefused | PluginFailure, Scope.Scope>
}

/**
 * Where a handle stands: it is the agent and takes turns (`Live`); `with`
 * is replacing it, and it takes none while the ones it runs finish
 * (`Replacing`); or it was replaced (`Replaced`).
 */
export const AgentPhase = Schema.Union([
  Schema.TaggedStruct("Live", { running: Schema.Int }),
  Schema.TaggedStruct("Replacing", { running: Schema.Int }),
  Schema.TaggedStruct("Replaced", {}),
])
export type AgentPhase = typeof AgentPhase.Type
