import { Match, Predicate, Result } from "effect"
import type { Prompt } from "effect/ai"
import type { Message } from "@xandreed/core/kernel"
import { InvalidBudget, Tokens } from "./memory.entity.js"
import type { OverBudget } from "./memory.entity.js"

/**
 * Text the host, not the user, adds to a context as a user-role message: `[Host note: …]`.
 *
 * @public
 */
export const hostNote = (text: string): string => `[Host note: ${text}]`

/**
 * Untrusted text (a summary a model wrote, a tool's output) inside `<tag>` and `</tag>`, each on its own line, with
 * every copy of the tag inside it, in any case or spacing, made inert (`</conversation-summary>` becomes
 * `</conversation_summary>`), so it cannot close the frame early or open another. The tag is lowercase with a hyphen.
 *
 * @public
 */
export const framed = (tag: string, text: string): string =>
  `<${tag}>\n${text.replace(new RegExp(`<\\s*/?\\s*${tag}(?![\\w-])[^>]*>`, "gi"), (found) => found.replaceAll("-", "_"))}\n</${tag}>`

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
 * Pairs are made in order, since a call's id is the model's and can repeat
 * (a model that numbers its calls starts again when its process does): a
 * result answers the last call of its id before it that nothing answered
 * yet. So a call left open, then asked again under the same id and
 * answered, is sent once, with that answer; a result with no call before
 * it, or a second result for one call, is not sent.
 *
 * @public
 */
export const paired = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  /** The message holding the last call of an id that no result has answered yet. */
  const open = new Map<string, number>()
  /** The calls that have their result, each as the message that asked and the id. */
  const answered = new Set<string>()
  /** The results that answer a call. */
  const answers = new Set<number>()
  messages.forEach((message, at) => {
    if (message._tag === "Assistant") message.toolCalls.forEach((call) => open.set(call.id, at))
    if (message._tag !== "ToolResult") return
    const asked = open.get(message.id)
    if (asked === undefined) return
    open.delete(message.id)
    answered.add(`${asked} ${message.id}`)
    answers.add(at)
  })
  return messages.flatMap((message, at): ReadonlyArray<Message> =>
    Match.valueTags(message, {
      User: () => [message],
      Assistant: (assistant) => {
        const toolCalls = assistant.toolCalls.filter((call) => answered.has(`${at} ${call.id}`))
        return assistant.text.length === 0 && toolCalls.length === 0 ? [] : [{ ...assistant, toolCalls }]
      },
      ToolResult: (result) => (answers.has(at) ? [result] : []),
    }))
}

/** The budget a memory was given, as whole tokens; a number that is no budget is refused. */
export const budgetOf = (budgetTokens: number): Result.Result<Tokens, InvalidBudget> =>
  Number.isFinite(budgetTokens) && budgetTokens >= 1
    ? Result.succeed(Tokens.make(Math.floor(budgetTokens)))
    : Result.fail(new InvalidBudget({ message: `a memory needs a budget of at least one token; it was given ${budgetTokens}` }))

/**
 * Whether an error is a memory's `OverBudget`, whichever memory or copy of the kernel raised it.
 *
 * @public
 */
export const isOverBudget = (error: unknown): error is OverBudget => Predicate.isTagged(error, "OverBudget")
