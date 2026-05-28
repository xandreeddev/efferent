import type { AgentMessage } from "../entities/Conversation.js"
import type { TokenUsage } from "../ports/LlmInfo.js"

/**
 * Bridges our persisted `AgentMessage` (Vercel-shaped) with `@effect/ai`'s
 * `Prompt`/`Response`. The opaque provider blob is carried verbatim both
 * ways — `AgentMessage.providerOptions ↔ Prompt part options ↔ Response
 * part metadata` — which is how Gemini's `thought_signature` round-trips
 * across our turns (the framework drops it via `fromResponseParts`, so we
 * never use that; we map by hand and keep the blob).
 */

type AnyPart = {
  readonly type: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly isFailure?: boolean
  readonly providerExecuted?: boolean
  readonly metadata?: unknown
  readonly usage?: unknown
}

const hasKeys = (o: unknown): o is Record<string, unknown> =>
  typeof o === "object" && o !== null && Object.keys(o).length > 0

const withOptions = (blob: unknown): { options?: unknown } =>
  hasKeys(blob) ? { options: blob } : {}

const withProviderOptions = (blob: unknown): { providerOptions?: unknown } =>
  hasKeys(blob) ? { providerOptions: blob } : {}

/** `AgentMessage[]` → `@effect/ai` encoded prompt messages (spreadable array). */
export const toPromptMessages = (
  messages: ReadonlyArray<AgentMessage>,
): Array<unknown> => {
  const out = messages.map((m) => {
    if (m.role === "user") {
      return { role: "user", content: m.content }
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content.map((p) => {
          if (p.type === "text") {
            return { type: "text", text: p.text, ...withOptions(p.providerOptions) }
          }
          if (p.type === "reasoning") {
            return {
              type: "reasoning",
              text: p.text,
              ...withOptions(p.providerOptions),
            }
          }
          // tool-call
          return {
            type: "tool-call",
            id: p.toolCallId,
            name: p.toolName,
            params: p.input ?? {},
            providerExecuted: p.providerExecuted ?? false,
            ...withOptions(p.providerOptions),
          }
        }),
        ...withOptions(m.providerOptions),
      }
    }
    // tool
    return {
      role: "tool",
      content: m.content.map((p) => ({
        type: "tool-result",
        id: p.toolCallId,
        name: p.toolName,
        result: p.output,
        isFailure: p.isError ?? false,
        providerExecuted: false,
        ...withOptions(p.providerOptions),
      })),
    }
  })
  return out
}

/**
 * One turn's response content parts → the `AgentMessage` tail (an assistant
 * message holding text/reasoning/tool-call parts, optionally followed by a
 * tool message holding the resolved tool-result parts). Provider metadata
 * (incl. `thought_signature`) is preserved into `providerOptions`.
 */
export const responseToAgentMessages = (
  content: ReadonlyArray<unknown>,
): Array<AgentMessage> => {
  const parts = content as ReadonlyArray<AnyPart>
  const assistantParts: Array<Record<string, unknown>> = []
  const toolParts: Array<Record<string, unknown>> = []

  for (const p of parts) {
    switch (p.type) {
      case "text":
        assistantParts.push({
          type: "text",
          text: p.text ?? "",
          ...withProviderOptions(p.metadata),
        })
        break
      case "reasoning":
        assistantParts.push({
          type: "reasoning",
          text: p.text ?? "",
          ...withProviderOptions(p.metadata),
        })
        break
      case "tool-call":
        assistantParts.push({
          type: "tool-call",
          toolCallId: p.id ?? "",
          toolName: p.name ?? "",
          input: p.params ?? {},
          providerExecuted: p.providerExecuted ?? false,
          ...withProviderOptions(p.metadata),
        })
        break
      case "tool-result":
        toolParts.push({
          type: "tool-result",
          toolCallId: p.id ?? "",
          toolName: p.name ?? "",
          output: p.result,
          isError: p.isFailure ?? false,
          ...withProviderOptions(p.metadata),
        })
        break
      default:
        break
    }
  }

  const out: Array<AgentMessage> = []
  if (assistantParts.length > 0) {
    out.push({ role: "assistant", content: assistantParts } as unknown as AgentMessage)
  }
  if (toolParts.length > 0) {
    out.push({ role: "tool", content: toolParts } as unknown as AgentMessage)
  }
  return out
}

/** Joined text of the assistant text parts in one turn's response content. */
export const responseText = (content: ReadonlyArray<unknown>): string =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")

/** Tool-call summaries `{ toolName, args }` from one turn's response content. */
export const responseToolCalls = (
  content: ReadonlyArray<unknown>,
): Array<{ toolName: string; args: unknown }> =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "tool-call")
    .map((p) => ({ toolName: p.name ?? "", args: p.params ?? {} }))

/** Tool-result summaries from one turn's response content. */
export const responseToolResults = (
  content: ReadonlyArray<unknown>,
): Array<{ toolName: string; ok: boolean; result: unknown }> =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "tool-result")
    .map((p) => ({
      toolName: p.name ?? "",
      ok: !(p.isFailure ?? false),
      result: p.result,
    }))

/** Token usage from a response's `usage` + Google finish-part metadata. */
export const extractUsage = (
  usage: unknown,
  content: ReadonlyArray<unknown>,
): TokenUsage => {
  const u = (usage ?? {}) as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  const finish = (content as ReadonlyArray<AnyPart>).find(
    (p) => p.type === "finish",
  )
  const um = (finish?.metadata as { google?: { usageMetadata?: Record<string, number> } })
    ?.google?.usageMetadata
  return {
    inputTokens: u.inputTokens ?? um?.promptTokenCount ?? 0,
    outputTokens: u.outputTokens ?? um?.candidatesTokenCount ?? 0,
    totalTokens: u.totalTokens ?? um?.totalTokenCount ?? 0,
    cacheReadTokens: um?.cachedContentTokenCount ?? 0,
  }
}
