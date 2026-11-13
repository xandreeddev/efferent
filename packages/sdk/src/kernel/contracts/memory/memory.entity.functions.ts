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

/** What a prompt message's part costs, as text: its text, a tool call's name and parameters, a result's JSON. */
const partText = (part: object): string =>
  "text" in part && typeof part.text === "string" ? part.text
    : "params" in part && "name" in part ? `${String(part.name)} ${JSON.stringify(part.params) ?? ""}`
      : "result" in part ? JSON.stringify(part.result) ?? ""
        : ""

/** The text a prompt message carries, whatever its encoding: its string, or the text of its parts. */
const textOf = (message: Prompt.MessageEncoded): string =>
  typeof message.content === "string" ? message.content : message.content.map(partText).join("")

/**
 * The estimate of a context, or of a whole prompt: the sum of its messages' estimates.
 *
 * @public
 */
export const estimateContext = (messages: ReadonlyArray<Prompt.MessageEncoded>): Tokens =>
  Tokens.make(messages.reduce<number>((sum, message) => sum + estimateTokens(textOf(message)), 0))

/**
 * A message of the conversation as text, for an estimate: what it says, and for the model's, the tools it called
 * with their parameters; a tool's result as its JSON.
 *
 * @public
 */
export const messageText = (message: Message): string =>
  Match.valueTags(message, {
    User: ({ text }) => text,
    Assistant: ({ text, toolCalls }) => [text, ...toolCalls.map((call) => `${call.name} ${JSON.stringify(call.input)}`)].filter((part) => part.length > 0).join(" "),
    ToolResult: ({ result }) => JSON.stringify(result),
  })

/**
 * A message of the conversation as a prompt sends it: a user's as a user
 * message; the model's as an assistant message, with its text and the tool
 * calls it made; a tool's result as a tool message answering its call.
 *
 * @public
 */
export const promptMessage = (message: Message): Prompt.UserMessageEncoded | Prompt.AssistantMessageEncoded | Prompt.ToolMessageEncoded =>
  Match.valueTags(message, {
    User: ({ text }): Prompt.UserMessageEncoded => ({ role: "user", content: text }),
    Assistant: ({ text, toolCalls }): Prompt.AssistantMessageEncoded => toolCalls.length === 0
      ? { role: "assistant", content: text }
      : {
        role: "assistant",
        content: [
          ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((call) => ({ type: "tool-call" as const, id: call.id, name: call.name, params: call.input })),
        ],
      },
    ToolResult: ({ id, name, result, isFailure }): Prompt.ToolMessageEncoded => ({
      role: "tool",
      content: [{ type: "tool-result", id, name, result, isFailure }],
    }),
  })

/**
 * The messages a provider accepts, out of `messages`: a tool call is kept
 * only with its result, and a result only with its call, and an answer left
 * with no text and no call is dropped. A turn stopped while a tool ran, or a
 * memory that cut a conversation between a call and its result, would
 * otherwise send a call no result answers, which a provider refuses. The
 * journal keeps every record; this decides only what is sent.
 *
 * @public
 */
export const paired = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  const answered = new Set(messages.flatMap((message) => (message._tag === "ToolResult" ? [message.id] : [])))
  const asked = new Set(messages.flatMap((message) => (message._tag === "Assistant" ? message.toolCalls.map((call) => call.id) : [])))
  return messages.flatMap((message): ReadonlyArray<Message> =>
    Match.valueTags(message, {
      User: () => [message],
      Assistant: (assistant) => {
        const toolCalls = assistant.toolCalls.filter((call) => answered.has(call.id))
        return assistant.text.length === 0 && toolCalls.length === 0 ? [] : [{ ...assistant, toolCalls }]
      },
      ToolResult: (result) => (asked.has(result.id) ? [result] : []),
    }))
}
