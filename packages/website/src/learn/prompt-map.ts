// Pure helpers shared by every browser model: the loop hands a model an
// `effect/ai` Prompt; small local models want plain chat messages, and the
// loop wants `effect/ai` response parts back.
import type { Prompt, Response } from "effect/ai"

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

export interface Usage {
  readonly inputTokens: { readonly total: number }
  readonly outputTokens: { readonly total: number }
}

const textOf = (parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
  parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("")

/**
 * Prompt -> chat messages. Lesson 1 sends text only: system, user and
 * assistant text survive; tool traffic and files (which lesson 1 never makes)
 * are dropped rather than guessed at.
 */
export const toChatMessages = (prompt: Prompt.Prompt): ReadonlyArray<ChatMessage> =>
  prompt.content.flatMap((message): ReadonlyArray<ChatMessage> => {
    if (message.role === "system") return message.content.length > 0 ? [{ role: "system", content: message.content }] : []
    if (message.role === "user" || message.role === "assistant") {
      const content = textOf(message.content)
      return content.length > 0 ? [{ role: message.role, content }] : []
    }
    return []
  })

/** ~4 characters a token: good enough to show a usage figure, never a limit. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const usageOf = (messages: ReadonlyArray<ChatMessage>, reply: string): Usage => ({
  inputTokens: { total: estimateTokens(messages.map((message) => message.content).join("\n")) },
  outputTokens: { total: estimateTokens(reply) },
})

/** The parts of a settled text answer. */
export const settledParts = (reply: string, usage: Usage): ReadonlyArray<Response.PartEncoded> =>
  [{ type: "text", text: reply }, { type: "finish", reason: "stop", usage }] as unknown as ReadonlyArray<Response.PartEncoded>

/** A stream of text deltas as `effect/ai` stream parts, ended by a finish part. */
export const streamStart = { type: "text-start", id: "text" } as const
export const streamDelta = (delta: string) => ({ type: "text-delta", id: "text", delta }) as const
export const streamEnd = { type: "text-end", id: "text" } as const
export const streamFinish = (usage: Usage) => ({ type: "finish", reason: "stop", usage }) as const

/**
 * Some streams send the text so far, some send only what is new, and the
 * Prompt API docs do not say which. The reader decides on the second chunk:
 * if it extends the first, the stream is cumulative; once decided it sticks.
 */
export const deltaReader = () => {
  let mode: "unknown" | "delta" | "cumulative" = "unknown"
  let first = ""
  let sent = ""
  return (chunk: string): string => {
    if (mode === "unknown" && first.length > 0) mode = chunk.length > first.length && chunk.startsWith(first) ? "cumulative" : "delta"
    if (first.length === 0) first = chunk
    const fresh = mode === "cumulative" ? chunk.slice(sent.length) : chunk
    sent = mode === "cumulative" ? chunk : sent + chunk
    return fresh
  }
}
