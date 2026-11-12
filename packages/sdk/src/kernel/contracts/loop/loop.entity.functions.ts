import type { Reply } from "./loop.entity.js"
import type { AssistantMessage } from "@xandreed/core/kernel"

/**
 * Whether the model asked for tools, so the turn has another step to run.
 *
 * @public
 */
export const wantsTools = (message: AssistantMessage): boolean => message.toolCalls.length > 0

/**
 * The reply a turn ends with: the text of its last assistant message.
 *
 * @public
 */
export const replyOf = (message: AssistantMessage): Reply => ({ text: message.text })
