import { Match, Option } from "effect"
import type { Prompt, Response, Tool } from "effect/ai"

/**
 * One part of a message as OpenTelemetry's generative AI conventions write it in `gen_ai.input.messages` and
 * `gen_ai.output.messages`: text, reasoning, a tool call with its arguments, a tool's response, or a file named by its
 * type alone (its bytes are never put on a span).
 */
export type ContentPart =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "reasoning"; readonly content: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown }
  | { readonly type: "tool_call_response"; readonly id: string; readonly response: unknown; readonly is_failure: boolean }
  | { readonly type: "file"; readonly mime_type: string }

/** A message as those conventions write it: who said it and its parts; an answer also says why it stopped. */
export interface ContentMessage {
  readonly role: string
  readonly parts: ReadonlyArray<ContentPart>
  readonly finish_reason?: string
}

/** What a call was sent, as the conventions split it: the system text apart, then the conversation's messages. */
export interface SentContent {
  readonly system: ReadonlyArray<ContentPart>
  readonly messages: ReadonlyArray<ContentMessage>
}

type PromptPart = Prompt.UserMessagePart | Prompt.AssistantMessagePart | Prompt.ToolMessagePart

const partOf = (part: PromptPart): ReadonlyArray<ContentPart> => Match.value(part).pipe(
  Match.discriminators("type")({
    text: ({ text }): ReadonlyArray<ContentPart> => [{ type: "text", content: text }],
    reasoning: ({ text }): ReadonlyArray<ContentPart> => [{ type: "reasoning", content: text }],
    file: ({ mediaType }): ReadonlyArray<ContentPart> => [{ type: "file", mime_type: mediaType }],
    "tool-call": ({ id, name, params }): ReadonlyArray<ContentPart> => [{ type: "tool_call", id, name, arguments: params }],
    "tool-result": ({ id, result, isFailure }): ReadonlyArray<ContentPart> => [{ type: "tool_call_response", id, response: result, is_failure: isFailure }],
  }),
  Match.orElse((): ReadonlyArray<ContentPart> => []),
)

/** A prompt as a call's span says it: the system messages' text apart, every other message with its parts. */
export const sentContentOf = (prompt: Prompt.Prompt): SentContent => ({
  system: prompt.content.flatMap((message): ReadonlyArray<ContentPart> => (message.role === "system" ? [{ type: "text", content: message.content }] : [])),
  messages: prompt.content.flatMap((message): ReadonlyArray<ContentMessage> => (message.role === "system"
    ? []
    : [{ role: message.role, parts: message.content.flatMap(partOf) }])),
})

/** A piece of text or reasoning, which a streamed answer gives a little at a time. */
const pieceOf = (part: ContentPart): Option.Option<{ readonly type: "text" | "reasoning"; readonly content: string }> =>
  part.type === "text" || part.type === "reasoning" ? Option.some(part) : Option.none()

/** The pieces of a streamed answer joined into the parts of one message, in the order they came. */
const joined = (parts: ReadonlyArray<ContentPart>, next: ContentPart): ReadonlyArray<ContentPart> => {
  const last = Option.flatMap(Option.fromNullishOr(parts.at(-1)), pieceOf)
  const piece = pieceOf(next)
  return Option.isSome(last) && Option.isSome(piece) && last.value.type === piece.value.type
    ? [...parts.slice(0, -1), { type: piece.value.type, content: last.value.content + piece.value.content }]
    : [...parts, next]
}

/**
 * An answer as a call's span says it: one assistant message of the text, the reasoning and the calls the model made,
 * in the order they came (a streamed answer's pieces joined), and why it stopped when it said so.
 */
export const answerContentOf = (response: ReadonlyArray<Response.AllParts<Record<string, Tool.Any>>>): ReadonlyArray<ContentMessage> => {
  const parts = response.flatMap((part): ReadonlyArray<ContentPart> => Match.value(part).pipe(
    Match.discriminators("type")({
      text: ({ text }): ReadonlyArray<ContentPart> => [{ type: "text", content: text }],
      "text-delta": ({ delta }): ReadonlyArray<ContentPart> => [{ type: "text", content: delta }],
      reasoning: ({ text }): ReadonlyArray<ContentPart> => [{ type: "reasoning", content: text }],
      "reasoning-delta": ({ delta }): ReadonlyArray<ContentPart> => [{ type: "reasoning", content: delta }],
      "tool-call": ({ id, name, params }): ReadonlyArray<ContentPart> => [{ type: "tool_call", id, name, arguments: params }],
    }),
    Match.orElse((): ReadonlyArray<ContentPart> => []),
  )).reduce<ReadonlyArray<ContentPart>>(joined, [])
  const finish = response.flatMap((part) => (part.type === "finish" ? [part.reason] : [])).at(-1)
  return [{ role: "assistant", parts, ...(finish === undefined ? {} : { finish_reason: finish }) }]
}
