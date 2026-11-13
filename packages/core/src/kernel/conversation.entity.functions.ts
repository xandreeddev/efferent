import { stored } from "./event.entity.functions.js"
import type { StoredDraft } from "./event.entity.js"
import { assistantMessageEvent, userMessageEvent } from "./conversation.entity.js"
import type { AssistantMessageData } from "./conversation.entity.js"
import type { ToolCall } from "./message.entity.js"

/** `conversation.user.message`: the user's text, for `session.append`. */
export const userMessage = (text: string): StoredDraft => stored(userMessageEvent, {}, { message: { _tag: "User", text } })

/**
 * `conversation.assistant.message`: the model's text, and the tools it asked for when it asked for any, for
 * `session.append`. `meta` is what the writer knows of the call: the model and its reported usage.
 */
export const assistantMessage = (
  text: string,
  meta: AssistantMessageData & { readonly toolCalls?: ReadonlyArray<ToolCall> } = {},
): StoredDraft => {
  const { toolCalls = [], ...data } = meta
  return stored(assistantMessageEvent, data, { message: { _tag: "Assistant", text, toolCalls } })
}
