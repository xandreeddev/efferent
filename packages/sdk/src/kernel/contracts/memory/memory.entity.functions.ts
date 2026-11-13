import { Match } from "effect"
import type { Prompt } from "effect/ai"
import type { Message } from "@xandreed/core/kernel"
import { Tokens } from "./memory.entity.js"

/**
 * The estimate of what a text costs, in tokens: a quarter of its
 * characters, rounded up. An approximation, and the only one: memory, the
 * kits and every reader count with this function.
 *
 * @public
 */
export const estimateTokens = (text: string): Tokens => Tokens.make(Math.ceil(text.length / 4))

/** The text a prompt message carries, whatever its encoding: its string, or the text of its parts. */
const textOf = (message: Prompt.MessageEncoded): string =>
  typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("")

/**
 * The estimate of a context, or of a whole prompt: the sum of its messages' estimates.
 *
 * @public
 */
export const estimateContext = (messages: ReadonlyArray<Prompt.MessageEncoded>): Tokens =>
  Tokens.make(messages.reduce<number>((sum, message) => sum + estimateTokens(textOf(message)), 0))

/**
 * A message of the conversation as a prompt sends it: a user's as a user
 * message, the model's as an assistant message, each with its text.
 *
 * @public
 */
export const promptMessage = (message: Message): Prompt.UserMessageEncoded | Prompt.AssistantMessageEncoded =>
  Match.valueTags(message, {
    User: ({ text }): Prompt.UserMessageEncoded => ({ role: "user", content: text }),
    Assistant: ({ text }): Prompt.AssistantMessageEncoded => ({ role: "assistant", content: text }),
  })
