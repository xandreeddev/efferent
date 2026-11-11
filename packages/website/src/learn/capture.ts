// What the model was actually sent. Every browser model goes through
// `makeBrowserModel`, which records the loop's raw request here, so the context
// inspector shows the real messages, not a copy built for one provider.
import { Schema } from "effect"
import { Prompt } from "effect/ai"

export interface CapturedMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly text: string
  /** The host-context tail the loop marks as changing every step (not cacheable). */
  readonly volatile: boolean
}

export interface CapturedRequest {
  readonly messages: ReadonlyArray<CapturedMessage>
  readonly tools: ReadonlyArray<string>
}

type Encoded = { readonly role: CapturedMessage["role"]; readonly content: unknown; readonly options?: unknown }

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? part.text : `[${part.type ?? "part"}]`)).join("")
}

export const captureOf = (prompt: Prompt.Prompt, tools: ReadonlyArray<{ readonly name: string }>): CapturedRequest => {
  const encoded = Schema.encodeSync(Prompt.Prompt)(prompt) as { content: ReadonlyArray<Encoded> }
  return {
    messages: encoded.content.map((message) => ({
      role: message.role,
      text: textOf(message.content),
      volatile: JSON.stringify(message.options ?? {}).includes("requestVolatile"),
    })),
    tools: tools.map((tool) => tool.name),
  }
}

const listeners = new Set<(request: CapturedRequest) => void>()

/** Listen for every request any browser model receives; returns the unsubscribe. */
export const onRequest = (listener: (request: CapturedRequest) => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const record = (prompt: Prompt.Prompt, tools: ReadonlyArray<{ readonly name: string }>): void => {
  if (listeners.size === 0) return
  const request = captureOf(prompt, tools)
  listeners.forEach((listener) => listener(request))
}
