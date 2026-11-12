import type { AssistantMessage, Reply } from "./message.entity.js"

/** Whether the model asked for tools, so the turn has another step to run. */
export const wantsTools = (message: AssistantMessage): boolean => message.toolCalls.length > 0

/** The reply a turn ends with: the text of its last assistant message. */
export const replyOf = (message: AssistantMessage): Reply => ({ text: message.text })
