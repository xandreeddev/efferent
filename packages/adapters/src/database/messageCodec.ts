import { Either, Schema } from "effect"
import type { AgentMessage } from "@efferent/core"

/**
 * Shared message (de)serialization for the SQL stores. Both `ConversationStore`
 * and `ContextTreeStore` persist a message as a denormalised `role` column plus
 * the rest of the message as JSON — TEXT in SQLite, jsonb in Postgres. This is
 * the one place that logic lives.
 */

/** Encode a message for storage: role goes in its own column, the rest as JSON. */
export const encodeMessageContent = (msg: AgentMessage): string => {
  const { role: _role, ...rest } = msg as Record<string, unknown>
  return JSON.stringify(rest)
}

/**
 * Decode a JSON string as a value — total. An unparseable string comes back
 * as-is, so a corrupt row fails the *downstream* message schema as the store's
 * tagged error instead of throwing past the Effect boundary as a defect.
 */
const JsonValue = Schema.parseJson(Schema.Unknown)
const parseJsonString = (s: string): unknown =>
  Either.getOrElse(Schema.decodeUnknownEither(JsonValue)(s), () => s)

/**
 * Reassemble a stored `(role, content)` row into a raw object ready for
 * `Schema.decodeUnknown(AgentMessage)`. `content` is a JSON *string* in SQLite
 * and an already-parsed object in Postgres (jsonb) — handle both, then
 * re-attach the denormalised `role`.
 */
export const reassembleMessageRow = (role: string, content: unknown): unknown => {
  const parsed = typeof content === "string" ? parseJsonString(content) : content
  return parsed !== null && typeof parsed === "object"
    ? { role, ...(parsed as Record<string, unknown>) }
    : parsed
}

/**
 * Read a JSON column that is a TEXT string in SQLite but already parsed in
 * Postgres (jsonb). Returns the parsed value (or the input when not a string).
 */
export const parseJsonColumn = (value: unknown): unknown =>
  typeof value === "string" ? parseJsonString(value) : value
