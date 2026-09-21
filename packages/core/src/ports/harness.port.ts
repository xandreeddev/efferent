import { Context } from "effect"
import type { Effect, Option, Stream } from "effect"
import type { Tool, Toolkit } from "@effect/ai"
import type { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody, MemoryEntry, SessionEvent, SessionRecord } from "../harness/session.entity.js"

export class SessionStore extends Context.Tag("efferent/SessionStore")<SessionStore, {
  readonly create: (workspace: string, profile: string) => Effect.Effect<SessionRecord, HarnessError>
  readonly get: (id: ConversationId) => Effect.Effect<SessionRecord, HarnessError>
  readonly list: (workspace: string) => Effect.Effect<ReadonlyArray<SessionRecord>, HarnessError>
  readonly read: (id: ConversationId, after: number) => Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError>
  readonly append: (id: ConversationId, body: EventBody) => Effect.Effect<SessionEvent, HarnessError>
  readonly fork: (id: ConversationId, through: number) => Effect.Effect<SessionRecord, HarnessError>
}>() {}

export interface LoopInput {
  readonly session: SessionRecord
  readonly runId: string
  readonly prompt: string
  readonly system: string
  readonly publish: (event: EventBody) => Effect.Effect<SessionEvent, HarnessError>
  readonly transient: (event: EventBody) => Effect.Effect<void>
  readonly steering: Effect.Effect<Option.Option<string>, HarnessError>
}

export class AgentLoop extends Context.Tag("efferent/AgentLoop")<AgentLoop, {
  readonly run: (input: LoopInput) => Effect.Effect<{ readonly text: string; readonly outcome: "completed" | "partial" }, HarnessError>
}>() {}

/** A workflow can delegate coding while retaining its own outer loop. */
export class DelegateLoop extends Context.Tag("efferent/DelegateLoop")<DelegateLoop, Context.Tag.Service<typeof AgentLoop>>() {}

export class AgentTools extends Context.Tag("efferent/AgentTools")<AgentTools, {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlers: Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>
  readonly prompt: string
}>() {}

export class ActionPolicy extends Context.Tag("efferent/ActionPolicy")<ActionPolicy, {
  readonly authorize: (tool: string, input: unknown) => Effect.Effect<void, HarnessError>
}>() {}

export class Approval extends Context.Tag("efferent/Approval")<Approval, {
  readonly request: (description: string) => Effect.Effect<boolean, HarnessError>
}>() {}

export class ContextManager extends Context.Tag("efferent/ContextManager")<ContextManager, {
  readonly compact: (messages: ReadonlyArray<AgentMessage>, tokens: number) => Effect.Effect<Option.Option<{ readonly summary: string; readonly keepFrom: number }>, HarnessError>
}>() {}

export class Memory extends Context.Tag("efferent/Memory")<Memory, {
  readonly recall: (workspace: string, query: string) => Effect.Effect<ReadonlyArray<MemoryEntry>, HarnessError>
  readonly remember: (workspace: string, text: string) => Effect.Effect<MemoryEntry, HarnessError>
  readonly forget: (workspace: string, id: string) => Effect.Effect<void, HarnessError>
}>() {}

export class SessionEnvironment extends Context.Tag("efferent/SessionEnvironment")<SessionEnvironment, {
  readonly workspace: string
  readonly session?: SessionRecord
}>() {}

/** Ordered hooks alter a turn; observers subscribe to the journal separately. */
export class TurnHooks extends Context.Tag("efferent/TurnHooks")<TurnHooks, {
  readonly before: (input: LoopInput) => Effect.Effect<LoopInput, HarnessError>
  readonly after: (input: LoopInput) => Effect.Effect<void, HarnessError>
}>() {}

export interface SessionHandle {
  readonly record: SessionRecord
  readonly use: <I, A, B, E, R>(tag: Context.Tag<I, A>, run: (service: A) => Effect.Effect<B, E, R>) => Effect.Effect<B, E | HarnessError, R>
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
