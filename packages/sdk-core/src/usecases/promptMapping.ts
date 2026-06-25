import type { AgentMessage } from "../entities/Conversation.js"
import type { TokenUsage } from "../ports/LlmInfo.js"

/**
 * Bridges our persisted `AgentMessage` with `@effect/ai`'s
 * `Prompt`/`Response`. The opaque provider blob is carried verbatim both
 * ways — `AgentMessage.providerOptions ↔ Prompt part options ↔ Response
 * part metadata` — which is how Gemini's `thought_signature` round-trips
 * across our turns (the framework drops it via `fromResponseParts`, so we
 * never use that; we map by hand and keep the blob).
 */

/**
 * Wrap a handoff summary as the single `user` message that stands in for all
 * the folded-away history. This is the domain representation of a checkpoint
 * for the model (kept in `core`, not the store adapter): `runAgent` prepends
 * it to the active window, and `createHandoff` prepends the prior summary when
 * re-summarizing so handoffs stay cumulative.
 */
export const handoffToMessage = (summary: string): AgentMessage => ({
  role: "user",
  content:
    "[System note: the earlier history of this conversation has been handed " +
    "off into the summary below to free up context. Treat the summary as the " +
    "source of truth for everything before this point.]\n\n" +
    summary,
})

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

/**
 * Some providers (notably Gemini's function-calling responses) return a
 * tool-call WITHOUT an `id`. An absent id is fatal to UI identity: the live
 * event pump can only invent a per-client-process fallback (`t<seq>`), which
 * differs between a live run and a later re-projection of the SAME persisted
 * messages — so a tool "pill" on the conversation rail duplicates or jumps to
 * the end on re-attach. The cure is to mint a DETERMINISTIC id ONCE, at the
 * source (the loop, per turn), and write it into the response content BEFORE it
 * is split into (a) the events the hooks emit and (b) the persisted
 * `AgentMessage`. Both then carry the identical id, and the projection reads it
 * straight back off `toolCallId` — live key === projected key, automatically.
 *
 * The id is `<turnIndex>:<toolName>:<ordinalInTurn>` — unique within the run
 * (turnIndex separates turns, the ordinal separates calls in a turn) and stable
 * because it's persisted, so a re-projection never re-mints it. The Nth
 * id-less tool-call and the Nth id-less tool-result pair on the same ordinal, so
 * a call and its result share the synthesized id and the assistant
 * tool-call ↔ tool-result pairing the loop relies on stays valid.
 *
 * MUTATES the parts in place (they are this turn's fresh response objects, not
 * shared) so every downstream read of `content` sees the same id. A non-empty
 * provider id is always left untouched — today's good path is unchanged.
 */
export const ensureToolCallIds = (
  content: ReadonlyArray<unknown>,
  turnIndex: number,
): void => {
  const parts = content as ReadonlyArray<Record<string, unknown>>
  let callOrd = 0
  let resultOrd = 0
  for (const part of parts) {
    const id = part["id"]
    const name = typeof part["name"] === "string" ? (part["name"] as string) : ""
    if (part["type"] === "tool-call") {
      if (id === undefined || id === "") part["id"] = `${turnIndex}:${name}:${callOrd}`
      callOrd++
    } else if (part["type"] === "tool-result") {
      if (id === undefined || id === "") part["id"] = `${turnIndex}:${name}:${resultOrd}`
      resultOrd++
    }
  }
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

/**
 * Joined text of the assistant *reasoning* parts in one turn's response —
 * the model's externalised thinking, when the provider surfaces it (OpenAI
 * reasoning models; Gemini only when thoughts are included). Empty otherwise.
 */
export const responseReasoning = (content: ReadonlyArray<unknown>): string =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "reasoning")
    .map((p) => p.text ?? "")
    .join("")
    .trim()

/** Tool-call summaries `{ id, toolName, args }` from one turn's response content.
 *  `id` is the provider tool-call id — the stable key that pairs a call with its
 *  result (two same-named calls in one turn share a name but not an id). */
export const responseToolCalls = (
  content: ReadonlyArray<unknown>,
): Array<{ id: string; toolName: string; args: unknown }> =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "tool-call")
    .map((p) => ({ id: p.id ?? "", toolName: p.name ?? "", args: p.params ?? {} }))

/** Tool-result summaries from one turn's response content; `id` matches the
 *  originating tool call's id. */
export const responseToolResults = (
  content: ReadonlyArray<unknown>,
): Array<{ id: string; toolName: string; ok: boolean; result: unknown }> =>
  (content as ReadonlyArray<AnyPart>)
    .filter((p) => p.type === "tool-result")
    .map((p) => ({
      id: p.id ?? "",
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
    cachedInputTokens?: number
  }
  // Some streaming adapters (e.g. OpenCode) emit a finish part from the
  // choice with finish_reason *and* a later usage-only finish part.
  // Scan all finish parts and pick the one that carries usage data.
  const finishes = (content as ReadonlyArray<AnyPart>).filter(
    (p) => p.type === "finish",
  )
  const finish =
    finishes.find((p) => {
      const fu = (p as AnyPart).usage as {
        inputTokens?: number
        outputTokens?: number
      } | undefined
      return fu?.inputTokens !== undefined || fu?.outputTokens !== undefined
    }) ?? finishes[0]
  const um = (finish?.metadata as { google?: { usageMetadata?: Record<string, number> } })
    ?.google?.usageMetadata
  const fu = finish?.usage as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
  } | undefined
  const inputTokens = u.inputTokens ?? fu?.inputTokens ?? um?.promptTokenCount ?? 0
  const outputTokens = u.outputTokens ?? fu?.outputTokens ?? um?.candidatesTokenCount ?? 0
  const totalTokens = u.totalTokens ?? fu?.totalTokens ?? um?.totalTokenCount ?? 0
  const cacheReadTokens =
    u.cachedInputTokens ?? fu?.cachedInputTokens ?? um?.cachedContentTokenCount ?? 0
  // Anthropic semantics differ from Gemini/OpenAI: `input_tokens` EXCLUDES
  // cache reads and cache writes (both ride only in the raw usage on the
  // finish part's anthropic metadata). Without this fold the context gauge
  // reads ~0 on a fully-cached Anthropic turn. Gemini/OpenAI already include
  // cached tokens in their prompt counts, so only the anthropic branch adds.
  const au = (finish?.metadata as { anthropic?: { usage?: Record<string, number> } })
    ?.anthropic?.usage
  if (au !== null && typeof au === "object") {
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

const EFFERENT_USAGE_KEY = "efferent"

/**
 * Embed the API-reported turn usage into the first assistant message's
 * `providerOptions` so it persists with the conversation and can be
 * recovered on resume / build.
 */
export const attachUsageToAssistant = (
  messages: Array<AgentMessage>,
  usage: TokenUsage,
): void => {
  const first = messages[0]
  if (first !== undefined && first.role === "assistant") {
    const prev =
      typeof first.providerOptions === "object" && first.providerOptions !== null
        ? (first.providerOptions as Record<string, unknown>)
        : {}
    ;(first as Record<string, unknown>).providerOptions = {
      ...prev,
      [EFFERENT_USAGE_KEY]: usage,
    }
  }
}

/** The turn usage embedded on a persisted assistant message, if any. */
export const assistantUsage = (msg: AgentMessage): TokenUsage | undefined => {
  if (msg.role !== "assistant") return undefined
  const opts = msg.providerOptions as Record<string, unknown> | undefined
  return opts?.[EFFERENT_USAGE_KEY] as TokenUsage | undefined
}

/**
 * Scan a persisted conversation for embedded turn usage and return:
 * - `lastUsage`: the most recent turn's input/cache (for the status bar)
 * - cumulative output/total/turns (for the side-pane activity view)
 */
export const recoverConversationStats = (
  messages: ReadonlyArray<AgentMessage>,
): {
  readonly lastUsage: TokenUsage | undefined
  readonly cumulativeOutput: number
  readonly cumulativeTotal: number
  readonly turns: number
} => {
  let cumulativeOutput = 0
  let cumulativeTotal = 0
  let turns = 0
  let lastUsage: TokenUsage | undefined

  for (const msg of messages) {
    const usage = assistantUsage(msg)
    if (usage !== undefined) {
      cumulativeOutput += usage.outputTokens
      cumulativeTotal += usage.totalTokens
      turns++
      lastUsage = usage
    }
  }

  return { lastUsage, cumulativeOutput, cumulativeTotal, turns }
}
