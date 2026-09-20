import { Option } from "effect"
import type { ToolCallSummary } from "../domain/loop-event.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import type {
  AgentMessage,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../domain/message.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"

/**
 * Bridges the persisted `AgentMessage` with `@effect/ai`'s `Prompt`/`Response`
 * encodings. The opaque provider blob is carried verbatim both ways —
 * `AgentMessage.providerOptions ↔ prompt part options ↔ response part
 * metadata` — which is how Gemini's `thought_signature` round-trips across
 * turns (the framework's own `fromResponseParts` drops it, so the engine maps
 * by hand and keeps the blob). Everything here is pure: no mutation, no IO.
 */

/** Wrap a fold summary as the single user message standing in for the folded
 *  history — prepended by `runAgent` when the conversation has a checkpoint. */
export const handoffToMessage = (summary: string): AgentMessage => ({
  role: "user",
  content:
    "[System note: the earlier history of this conversation has been handed " +
    "off into the summary below to free up context. Treat the summary as the " +
    "source of truth for everything before this point.]\n\n" +
    summary,
})

/**
 * The largest SAFE fold cut keeping at least `keepTurns` assistant turns
 * verbatim: the cut always lands ON an assistant message (a tool message
 * follows its assistant, so a tool-call is never split from its results),
 * and never at index 0 (something must fold). `None` when the buffer is too
 * small to fold at all.
 */
export const safeKeepFrom = (
  messages: ReadonlyArray<AgentMessage>,
  keepTurns: number,
): Option.Option<number> => {
  const assistantIndexes = messages.flatMap((message, index) =>
    message.role === "assistant" ? [index] : [],
  )
  if (assistantIndexes.length <= keepTurns) return Option.none()
  const cut = assistantIndexes[assistantIndexes.length - keepTurns]
  return cut === undefined || cut <= 0 ? Option.none() : Option.some(cut)
}

/** The read-side projection of a response content part (type-erased). */
interface AnyPart {
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

const withOptions = (blob: unknown): { readonly options?: unknown } =>
  hasKeys(blob) ? { options: blob } : {}

const withProviderOptions = (blob: unknown): { readonly providerOptions?: unknown } =>
  hasKeys(blob) ? { providerOptions: blob } : {}

/** The engine's own usage stamp inside `providerOptions` (see
 *  {@link withUsageOnAssistant}). */
const USAGE_KEY = "engine"

/** The provider blob rides out verbatim — EXCEPT the engine's own stamp,
 *  which is engine-private bookkeeping: replaying it to a provider is at
 *  best noise, at worst a 400 on a strict gateway. */
const withoutEngineStamp = (blob: unknown): unknown => {
  if (!hasKeys(blob)) return blob
  const { [USAGE_KEY]: _engine, ...rest } = blob
  return rest
}

/** `AgentMessage[]` → `@effect/ai` encoded prompt messages (spreadable). */
export const toPromptMessages = (
  messages: ReadonlyArray<AgentMessage>,
): ReadonlyArray<unknown> =>
  messages.map((m) => {
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
            return { type: "reasoning", text: p.text, ...withOptions(p.providerOptions) }
          }
          return {
            type: "tool-call",
            id: p.toolCallId,
            name: p.toolName,
            params: p.input ?? {},
            providerExecuted: p.providerExecuted ?? false,
            ...withOptions(p.providerOptions),
          }
        }),
        ...withOptions(withoutEngineStamp(m.providerOptions)),
      }
    }
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

/**
 * Some providers (notably Gemini) return tool calls WITHOUT an id. An absent
 * id breaks durable UI identity (a live event and a later re-projection of
 * the same persisted message must compute the same key), so a deterministic
 * id — `<turnIndex>:<toolName>:<ordinalInTurn>` — is minted ONCE here, before
 * the content fans out into events and persisted messages. The Nth id-less
 * call and the Nth id-less result pair on the same ordinal, so the
 * call ↔ result pairing stays valid. A non-empty provider id is left as-is.
 *
 * Pure: returns new part objects; the input is never mutated.
 */
export const withToolCallIds = (
  content: ReadonlyArray<unknown>,
  turnIndex: number,
): ReadonlyArray<unknown> =>
  content
    .reduce(
      (acc: { calls: number; results: number; out: ReadonlyArray<unknown> }, part) => {
        const p = part as AnyPart
        const bare = p.id === undefined || p.id === ""
        if (p.type === "tool-call") {
          return {
            calls: acc.calls + 1,
            results: acc.results,
            out: [
              ...acc.out,
              bare ? { ...p, id: `${turnIndex}:${p.name ?? ""}:${acc.calls}` } : part,
            ],
          }
        }
        if (p.type === "tool-result") {
          return {
            calls: acc.calls,
            results: acc.results + 1,
            out: [
              ...acc.out,
              bare ? { ...p, id: `${turnIndex}:${p.name ?? ""}:${acc.results}` } : part,
            ],
          }
        }
        return { ...acc, out: [...acc.out, part] }
      },
      { calls: 0, results: 0, out: [] },
    ).out

/**
 * One turn's response content → the `AgentMessage` tail: an assistant message
 * holding text/reasoning/tool-call parts, then a tool message holding the
 * resolved tool-result parts. Provider metadata (incl. `thought_signature`)
 * is preserved into `providerOptions`.
 */
export const responseToAgentMessages = (
  content: ReadonlyArray<unknown>,
): ReadonlyArray<AgentMessage> => {
  const parts = content as ReadonlyArray<AnyPart>
  const assistantParts = parts.flatMap(
    (p): ReadonlyArray<TextPart | ReasoningPart | ToolCallPart> => {
    if (p.type === "text") {
      return [{ type: "text" as const, text: p.text ?? "", ...withProviderOptions(p.metadata) }]
    }
    if (p.type === "reasoning") {
      return [
        { type: "reasoning" as const, text: p.text ?? "", ...withProviderOptions(p.metadata) },
      ]
    }
    if (p.type === "tool-call") {
      return [
        {
          type: "tool-call" as const,
          toolCallId: ToolCallId.make(p.id ?? ""),
          toolName: p.name ?? "",
          input: p.params ?? {},
          providerExecuted: p.providerExecuted ?? false,
          ...withProviderOptions(p.metadata),
        },
      ]
    }
    return []
    },
  )
  const toolParts = parts.flatMap((p): ReadonlyArray<ToolResultPart> =>
    p.type === "tool-result"
      ? [
          {
            type: "tool-result" as const,
            toolCallId: ToolCallId.make(p.id ?? ""),
            toolName: p.name ?? "",
            output: p.result,
            isError: p.isFailure ?? false,
            ...withProviderOptions(p.metadata),
          },
        ]
      : [],
  )
  return [
    ...(assistantParts.length > 0
      ? [{ role: "assistant" as const, content: assistantParts }]
      : []),
    ...(toolParts.length > 0 ? [{ role: "tool" as const, content: toolParts }] : []),
  ]
}

/** Joined text of the assistant text parts in one turn's response. */
export const responseText = (content: ReadonlyArray<unknown>): string =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")

/** Joined text of the reasoning parts (when the provider surfaces them). */
export const responseReasoning = (content: ReadonlyArray<unknown>): string =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "reasoning")
    .map((p) => p.text ?? "")
    .join("")
    .trim()

/** Tool-call summaries; `id` is the key that pairs a call with its result. */
export const responseToolCalls = (
  content: ReadonlyArray<unknown>,
): ReadonlyArray<ToolCallSummary> =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "tool-call")
    .map((p) => ({ id: p.id ?? "", toolName: p.name ?? "", args: p.params ?? {} }))

export interface ToolResultSummary {
  readonly id: string
  readonly toolName: string
  readonly ok: boolean
  readonly result: unknown
}

/** Tool-result summaries; `id` matches the originating call's id. */
export const responseToolResults = (
  content: ReadonlyArray<unknown>,
): ReadonlyArray<ToolResultSummary> =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "tool-result")
    .map((p) => ({
      id: p.id ?? "",
      toolName: p.name ?? "",
      ok: !(p.isFailure ?? false),
      result: p.result,
    }))

/**
 * Token usage from a response's `usage` + the finish part's metadata. The
 * Anthropic fold matters: its `input_tokens` EXCLUDES cache reads/writes
 * (both ride only in the raw usage on the finish part's anthropic metadata),
 * so without folding them back a fully-cached turn reads ~0 input.
 * Gemini/OpenAI already include cached tokens in their prompt counts.
 */
export const extractUsage = (
  usage: unknown,
  content: ReadonlyArray<unknown>,
): TokenUsage => {
  const u = (usage ?? {}) as {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly totalTokens?: number
    readonly cachedInputTokens?: number
  }
  // Some streaming adapters emit a finish part from the choice AND a later
  // usage-only finish part — scan all of them, prefer the one carrying usage.
  const finishes = (content as ReadonlyArray<AnyPart>).filter((p) => p.type === "finish")
  const finish =
    finishes.find((p) => {
      const fu = p.usage as { readonly inputTokens?: number; readonly outputTokens?: number } | undefined
      return fu?.inputTokens !== undefined || fu?.outputTokens !== undefined
    }) ?? finishes[0]
  const gm = (finish?.metadata as
    | { readonly google?: { readonly usageMetadata?: Record<string, number> } }
    | undefined)?.google?.usageMetadata
  const fu = finish?.usage as
    | {
        readonly inputTokens?: number
        readonly outputTokens?: number
        readonly totalTokens?: number
        readonly cachedInputTokens?: number
      }
    | undefined
  const inputTokens = u.inputTokens ?? fu?.inputTokens ?? gm?.["promptTokenCount"] ?? 0
  const outputTokens = u.outputTokens ?? fu?.outputTokens ?? gm?.["candidatesTokenCount"] ?? 0
  const totalTokens = u.totalTokens ?? fu?.totalTokens ?? gm?.["totalTokenCount"] ?? 0
  const cacheReadTokens =
    u.cachedInputTokens ?? fu?.cachedInputTokens ?? gm?.["cachedContentTokenCount"] ?? 0
  const au = (finish?.metadata as
    | { readonly anthropic?: { readonly usage?: Record<string, number> } }
    | undefined)?.anthropic?.usage
  if (au !== undefined && au !== null && typeof au === "object") {
    const cacheRead = au["cache_read_input_tokens"] ?? 0
    const cacheWrite = au["cache_creation_input_tokens"] ?? 0
    const fullInput = inputTokens + cacheRead + cacheWrite
    return {
      inputTokens: fullInput,
      outputTokens,
      totalTokens: fullInput + outputTokens,
      cacheReadTokens: cacheRead,
    }
  }
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens }
}

/**
 * Embed the turn usage into the first assistant message's `providerOptions`
 * so it persists with the conversation and can be recovered on resume. Pure —
 * returns a new array with the first assistant message re-built.
 * {@link toPromptMessages} strips this stamp before anything goes back out.
 */
export const withUsageOnAssistant = (
  messages: ReadonlyArray<AgentMessage>,
  usage: TokenUsage,
  model: Option.Option<string> = Option.none(),
): ReadonlyArray<AgentMessage> => {
  const at = messages.findIndex((m) => m.role === "assistant")
  const stamp = {
    ...usage,
    ...Option.match(model, { onNone: () => ({}), onSome: (id) => ({ model: id }) }),
  }
  return messages.map((m, i) => {
    if (i !== at || m.role !== "assistant") return m
    const prev = hasKeys(m.providerOptions) ? m.providerOptions : {}
    return { ...m, providerOptions: { ...prev, [USAGE_KEY]: stamp } }
  })
}

/** The resolved `provider:modelId` the router stamped onto the finish part. */
export const extractModel = (content: ReadonlyArray<unknown>): Option.Option<string> => {
  const finish = (content as ReadonlyArray<AnyPart>).find((p) => p.type === "finish")
  const model = (finish?.metadata as { readonly router?: { readonly model?: unknown } } | undefined)
    ?.router?.model
  return typeof model === "string" && model.length > 0 ? Option.some(model) : Option.none()
}

/** The turn usage embedded on a persisted assistant message, if any. */
export const assistantUsage = (msg: AgentMessage): Option.Option<TokenUsage> => {
  if (msg.role !== "assistant") return Option.none()
  const opts = msg.providerOptions as Record<string, unknown> | undefined
  const usage = opts?.[USAGE_KEY]
  return hasKeys(usage) ? Option.some(usage as TokenUsage) : Option.none()
}

/** The `provider:modelId` embedded alongside the usage stamp, if any. */
export const assistantModel = (msg: AgentMessage): Option.Option<string> => {
  if (msg.role !== "assistant") return Option.none()
  const opts = msg.providerOptions as Record<string, unknown> | undefined
  const model = (opts?.[USAGE_KEY] as { readonly model?: unknown } | undefined)?.model
  return typeof model === "string" && model.length > 0 ? Option.some(model) : Option.none()
}
