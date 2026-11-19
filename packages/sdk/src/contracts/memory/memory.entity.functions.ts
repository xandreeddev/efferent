import { Match, Option, Predicate, Result } from "effect"
import type { Prompt } from "effect/ai"
import { dataOf, messageOf, userMessageEvent } from "@xandreed/core"
import type { Message, StoredEvent } from "@xandreed/core"
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
 * The marker a clip leaves in place of the characters it dropped: `[… 1234 characters clipped]`.
 *
 * @public
 */
export const clippedMarker = (dropped: number): string => `[… ${dropped} characters clipped]`

/** The place at or before `end` where a text can be cut without leaving half a character (the first half of a surrogate pair). */
const wholeEnd = (text: string, end: number): number => (end > 0 && end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800 ? end - 1 : end)

/**
 * A text in at most `max` characters: itself when it fits; otherwise its start, then, on a line of its own, a
 * marker that counts what was left out (`clippedMarker`). The start never ends on half a character. When `max` has
 * no room for a marker, only the start is given. Every text of unknown length that a kernel prompt holds is
 * bounded with it, so a model is told that something is missing and how much.
 *
 * @public
 */
export const clipTo = (text: string, max: number): string => {
  if (text.length <= max) return text
  const room = max - clippedMarker(text.length).length - 1
  if (room <= 0) return text.slice(0, wholeEnd(text, Math.max(0, max)))
  const end = wholeEnd(text, room)
  return `${text.slice(0, end)}\n${clippedMarker(text.length - end)}`
}

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

/** A call's place among `messages`: the message that asked, and the call's place in it. */
export const callAt = (message: number, call: number): string => `${message} ${call}`

/**
 * Which result answers which call, among `messages`: for each answered call (`callAt`), the place of the message
 * that is its result. A call is told from another by its place, never by its id alone, which is the model's and
 * can repeat.
 *
 * - Across answers, the newer answer's calls of an id replace an older answer's that nothing answered: a turn
 *   stopped while its tool ran, and its id asked again later.
 * - Inside one answer that asks more than once under one id, the results stored after it answer those calls in
 *   the order they were asked: the first result is the first call's. That is the order a loop that runs an
 *   answer's calls one after another stores them in, as the kernel's `callTool` is used. A host that runs the
 *   calls of one answer at once, under one id, stores results this cannot tell apart.
 * - A result with no open call of its id answers nothing.
 *
 * It is the one rule both `paired` (what a model is sent) and `turnsOf` (what a test reads) pair by.
 */
export const pairsOf = (messages: ReadonlyArray<Message>): ReadonlyMap<string, number> => {
  /** The calls of each id that no result has answered yet, in the order asked: those of the latest answer that asked under it. */
  const open = new Map<string, ReadonlyArray<string>>()
  const pairs = new Map<string, number>()
  messages.forEach((message, at) =>
    Match.valueTags(message, {
      User: () => {},
      Assistant: ({ toolCalls }) => {
        const asked = new Map<string, ReadonlyArray<string>>()
        toolCalls.forEach((call, index) => asked.set(call.id, [...(asked.get(call.id) ?? []), callAt(at, index)]))
        asked.forEach((calls, id) => open.set(id, calls))
      },
      ToolResult: ({ id }) => {
        const [first, ...rest] = open.get(id) ?? []
        if (first === undefined) return
        open.set(id, rest)
        pairs.set(first, at)
      },
    }))
  return pairs
}

/**
 * The messages a provider accepts, out of `messages`: a tool call is kept
 * only with its result, and a result only with its call, and an answer left
 * with no text and no call is dropped. A turn stopped while a tool ran, or a
 * memory that cut a conversation between a call and its result, would
 * otherwise send a call no result answers, which a provider refuses. The
 * journal keeps every record; this decides only what is sent.
 *
 * Pairs are made in order (`pairsOf`), since a call's id is the model's and
 * can repeat (a model that numbers its calls starts again when its process
 * does): a result answers a call of the last answer before it that asked
 * under its id, the first of them that nothing answered yet. So a call left
 * open, then asked again in a later answer under the same id and
 * answered, is sent once, with that answer; of two calls one answer makes
 * under one id, each is sent with its own result, the first stored being
 * the first call's, and one that has none is not sent; a result with no
 * call before it, or a second result for one call, is not sent.
 *
 * @public
 */
export const paired = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  const pairs = pairsOf(messages)
  /** The results that answer a call. */
  const answers = new Set(pairs.values())
  return messages.flatMap((message, at): ReadonlyArray<Message> =>
    Match.valueTags(message, {
      User: () => [message],
      Assistant: (assistant) => {
        const toolCalls = assistant.toolCalls.filter((_, index) => pairs.has(callAt(at, index)))
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

/**
 * The question a context is built for: the text of the last `conversation.user.message` in the conversation's
 * journal (never a report another session sent, ADR 0018), or no text when there is none. It is read from the journal by the record's name, never by a message's
 * role: a wrapper's note in a context is a user-role message, and so is one a plugin stores in the conversation
 * under a record of its own.
 *
 * @public
 */
export const questionOf = (journal: ReadonlyArray<StoredEvent>): string =>
  journal
    // The person's messages only: a report another session sent (ADR 0018) names it in `from`, and is no question.
    .flatMap((event) => (Option.exists(dataOf(userMessageEvent, event), (data) => data.from === undefined) ? Option.toArray(messageOf(event)) : []))
    .flatMap((message) => (message._tag === "User" ? [message.text] : []))
    .at(-1) ?? ""
