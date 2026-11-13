import { Option, Schema } from "effect"
import { stored } from "./event.entity.functions.js"
import type { StoredDraft } from "./event.entity.js"
import { assistantMessageEvent, toolResultEvent, userMessageEvent } from "./conversation.entity.js"
import type { AssistantMessageData } from "./conversation.entity.js"
import { ToolCallId } from "./ids.entity.js"

/** A tool call as a model's stream part names it: its id, the tool, and the parameters it sent. */
interface CallPart {
  readonly id: string
  readonly name: string
  readonly params: unknown
}

const fromText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/**
 * A value from a provider or a tool as stored JSON, as `JSON.stringify` writes it: a key whose value is `undefined`
 * is left out, `NaN` is `null`, a date its ISO text; nothing at all is `null`.
 */
const jsonOf = (value: unknown): Schema.Json => Option.getOrElse(fromText(JSON.stringify(value) ?? "null"), () => null)

/** `conversation.user.message`: the user's text, for `session.append`. */
export const userMessage = (text: string): StoredDraft => stored(userMessageEvent, {}, { message: { _tag: "User", text } })

/**
 * `conversation.assistant.message`: the model's text, and the tools it asked for when it asked for any, for
 * `session.append`. `toolCalls` are the model's `tool-call` stream parts as they came; `model` and `usage` are what
 * the writer knows of the call.
 */
export const assistantMessage = (
  text: string,
  meta: AssistantMessageData & { readonly toolCalls?: ReadonlyArray<CallPart> } = {},
): StoredDraft => {
  const { toolCalls = [], ...data } = meta
  const calls = toolCalls.map((call) => ({ id: ToolCallId.make(call.id), name: call.name, input: jsonOf(call.params) }))
  return stored(assistantMessageEvent, data, { message: { _tag: "Assistant", text, toolCalls: calls } })
}

/**
 * `conversation.tool.result`: what the call `call` came to, for `session.append`. `result` is what the tool
 * returned, as it encodes it, or, with `isFailure`, what went wrong: a failure is stored as an answer, and the
 * turn goes on.
 */
export const toolResult = (call: Omit<CallPart, "params">, result: unknown, isFailure = false): StoredDraft =>
  stored(toolResultEvent, {}, { message: { _tag: "ToolResult", id: ToolCallId.make(call.id), name: call.name, result: jsonOf(result), isFailure } })
