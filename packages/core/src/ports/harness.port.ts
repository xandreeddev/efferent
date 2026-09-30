import { Context } from "effect"
import type { Effect, Option, Stream } from "effect"
import type { Tool, Toolkit } from "effect/ai"
import type { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody, MemoryEntry, SessionEvent, SessionRecord } from "../harness/session.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"

/** @deprecated Historical event vocabulary; live adapters project it over SessionLog. New hosts use Sessions and TurnWriter. */
export class SessionStore extends Context.Service<SessionStore, {
  readonly create: (workspace: string, profile: string) => Effect.Effect<SessionRecord, HarnessError>
  readonly get: (id: ConversationId) => Effect.Effect<SessionRecord, HarnessError>
  readonly list: (workspace: string) => Effect.Effect<ReadonlyArray<SessionRecord>, HarnessError>
  readonly read: (id: ConversationId, after: number) => Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError>
  readonly append: (id: ConversationId, body: EventBody) => Effect.Effect<SessionEvent, HarnessError>
  readonly fork: (id: ConversationId, through: number) => Effect.Effect<SessionRecord, HarnessError>
}>()("efferent/SessionStore") {}

export interface LoopInput {
  readonly session: SessionRecord
  readonly runId: string
  readonly userMessage: UserMessage
  readonly system: string
  readonly publish: (event: EventBody) => Effect.Effect<SessionEvent, HarnessError>
  readonly transient: (event: EventBody) => Effect.Effect<void>
  readonly steering: Effect.Effect<Option.Option<string>, HarnessError>
  /** Journal reads for memory plugins: events after `after`, filtered by name (all when empty). */
  readonly history: (after: number, names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError>
  /** Host services the run's tools and hooks may require (data ports, per-turn models). */
  readonly services: Context.Context<never>
}

export class AgentLoop extends Context.Service<AgentLoop, {
  readonly run: (input: LoopInput) => Effect.Effect<{ readonly text: string; readonly outcome: "completed" | "partial" }, HarnessError>
}>()("efferent/AgentLoop") {}

/** A workflow can delegate coding while retaining its own outer loop. */
export class DelegateLoop extends Context.Service<DelegateLoop, Context.Service.Shape<typeof AgentLoop>>()("efferent/DelegateLoop") {}

export class AgentTools extends Context.Service<AgentTools, {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlers: Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>
  readonly prompt: string
}>()("efferent/AgentTools") {}

export class ActionPolicy extends Context.Service<ActionPolicy, {
  readonly authorize: (tool: string, input: unknown) => Effect.Effect<void, HarnessError>
}>()("efferent/ActionPolicy") {}

export class Approval extends Context.Service<Approval, {
  readonly request: (description: string) => Effect.Effect<boolean, HarnessError>
}>()("efferent/Approval") {}

export class ContextManager extends Context.Service<ContextManager, {
  readonly compact: (messages: ReadonlyArray<AgentMessage>, tokens: number) => Effect.Effect<Option.Option<{ readonly summary: string; readonly keepFrom: number }>, HarnessError>
}>()("efferent/ContextManager") {}

export class Memory extends Context.Service<Memory, {
  readonly recall: (workspace: string, query: string) => Effect.Effect<ReadonlyArray<MemoryEntry>, HarnessError>
  readonly remember: (workspace: string, text: string) => Effect.Effect<MemoryEntry, HarnessError>
  readonly forget: (workspace: string, id: string) => Effect.Effect<void, HarnessError>
}>()("efferent/Memory") {}

export class SessionEnvironment extends Context.Service<SessionEnvironment, {
  readonly workspace: string
  readonly session?: SessionRecord
}>()("efferent/SessionEnvironment") {}

/** Ordered hooks alter a turn; observers subscribe to the journal separately. */
export class TurnHooks extends Context.Service<TurnHooks, {
  readonly before: (input: LoopInput) => Effect.Effect<LoopInput, HarnessError>
  readonly after: (input: LoopInput) => Effect.Effect<void, HarnessError>
}>()("efferent/TurnHooks") {}

export interface SessionHandle {
  readonly record: SessionRecord
  readonly use: <I, A, B, E, R>(tag: Context.Service<I, A>, run: (service: A) => Effect.Effect<B, E, R>) => Effect.Effect<B, E | HarnessError, R>
  readonly send: (text: string) => Effect.Effect<void, HarnessError>
  readonly steer: (text: string) => Effect.Effect<void, HarnessError>
  readonly interrupt: Effect.Effect<void>
  readonly events: (after?: number) => Stream.Stream<SessionEvent, HarnessError>
  readonly transient: Stream.Stream<EventBody>
  readonly history: Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError>
  readonly busy: Effect.Effect<boolean>
  readonly pending: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly text: string }>>
  readonly continue: Effect.Effect<void, HarnessError>
  readonly refresh: Effect.Effect<void, HarnessError>
  readonly close: Effect.Effect<void>
}
