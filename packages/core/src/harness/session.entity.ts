import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"

export const SessionRecord = Schema.Struct({
  id: ConversationId,
  workspace: Schema.String,
  profile: Schema.String,
  createdAt: Schema.Number,
  parent: Schema.optional(ConversationId),
})
export type SessionRecord = typeof SessionRecord.Type

export const EventBody = Schema.Struct({
  name: Schema.NonEmptyString,
  runId: Schema.optional(Schema.String),
  data: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type EventBody = typeof EventBody.Type

export const SessionEvent = Schema.Struct({
  ...EventBody.fields,
  version: Schema.Literal(1),
  id: Schema.String,
  sessionId: ConversationId,
  seq: Schema.Int,
  at: Schema.Number,
})
export type SessionEvent = typeof SessionEvent.Type

export const MemoryEntry = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  text: Schema.String,
  createdAt: Schema.Number,
})
export type MemoryEntry = typeof MemoryEntry.Type
