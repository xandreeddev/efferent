// A conversation message as the page shows and matches it: who it is from,
// its text, and the key that ties it to the record it came from. A user's or
// the model's text matches by role and text; a tool call and its result by
// the call's id, since they have no text of their own.
import { Match } from "effect"
import type { Message } from "@xandreed/core/kernel"
import type { Said } from "./runtime.ts"

const json = (value: unknown): string => JSON.stringify(value) ?? ""

type PartLike = object
const callIdsOf = (parts: ReadonlyArray<PartLike>) =>
  parts.flatMap((part) => ("type" in part && part.type === "tool-call" && "id" in part ? [String(part.id)] : []))

const keyOf = (role: string, text: string, callIds: ReadonlyArray<string>, resultId?: string) =>
  resultId !== undefined ? `result:${resultId}` : `${role}:${text}${callIds.length > 0 ? `|${callIds.join(",")}` : ""}`

/** A prompt message, decoded or encoded, as the page shows it. */
export const saidOfMessage = (message: { readonly role: string; readonly content: string | ReadonlyArray<PartLike> }): Said => {
  if (typeof message.content === "string") return { role: message.role, text: message.content, key: keyOf(message.role, message.content, []) }
  const parts = message.content
  const text = parts.flatMap((part) => ("type" in part && part.type === "text" && "text" in part ? [String(part.text)] : [])).join("")
  const calls = parts.flatMap((part) => ("type" in part && part.type === "tool-call" && "name" in part ? [`${String(part.name)}(${json("params" in part ? part.params : {})})`] : []))
  const result = parts.find((part) => "type" in part && part.type === "tool-result")
  if (result !== undefined && "id" in result) {
    const failed = "isFailure" in result && result.isFailure === true
    return { role: message.role, text: `${"name" in result ? String(result.name) : "tool"} ${failed ? "failed: " : "→ "}${json("result" in result ? result.result : null)}`, key: keyOf(message.role, "", [], String(result.id)), resultId: String(result.id) }
  }
  const shown = [text, ...calls.map((call) => `calls ${call}`)].filter((part) => part.length > 0).join(" · ")
  return { role: message.role, text: shown, key: keyOf(message.role, text, callIdsOf(parts)), callIds: callIdsOf(parts), body: text }
}

/** A stored message as the page shows it, with the same key its prompt message gets. */
export const saidOfStored = (message: Message): Said =>
  Match.valueTags(message, {
    User: ({ text }) => ({ role: "user", text, key: keyOf("user", text, []) }),
    Assistant: ({ text, toolCalls }) => ({
      role: "assistant",
      text: [text, ...toolCalls.map((call) => `calls ${call.name}(${json(call.input)})`)].filter((part) => part.length > 0).join(" · "),
      key: keyOf("assistant", text, toolCalls.map((call) => call.id)),
      callIds: toolCalls.map((call) => call.id),
      body: text,
    }),
    ToolResult: ({ id, name, result, isFailure }) => ({ role: "tool", text: `${name} ${isFailure ? "failed: " : "→ "}${json(result)}`, key: keyOf("tool", "", [], id), resultId: id }),
  })

/**
 * Whether a message of a context came from a stored record: a result answers the same call; any other message has
 * the record's role and text, and makes only calls the record made (memory may leave out a call no result answered).
 */
export const cameFrom = (message: Said, record: Said): boolean =>
  message.resultId !== undefined || record.resultId !== undefined
    ? message.resultId === record.resultId
    : message.role === record.role
      && (message.callIds ?? []).every((id) => (record.callIds ?? []).includes(id))
      && (message.body ?? message.text) === (record.body ?? record.text)
