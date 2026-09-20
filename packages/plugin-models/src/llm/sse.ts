import { AiError } from "@effect/ai"
import type { Response } from "@effect/ai"
import { Effect, Option, Stream } from "effect"

/**
 * The OpenAI-compatible SSE wire → `@effect/ai` `StreamPartEncoded`s, as a
 * PURE state machine over `data:` lines. Owned here so `compat.ts` imports
 * one direction only (this module knows nothing of fetch or auth).
 *
 * Invariant ("content-part identity"): a content part is a NON-EMPTY
 * text/reasoning delta or a completed tool call — empty deltas emit nothing.
 * The retry gate (S2) and the engine fold (S3) both hinge on that.
 *
 * A DONE sentinel is concatenated after the wire lines so the flush (open
 * chunk ends → accumulated tool calls → finish) runs even when the gateway
 * never sends `[DONE]`; a second sentinel is idempotent via `flushed`.
 */

/** The usage object OpenAI-compatible completions carry (streaming sends it
 *  on the last chunk under `stream_options: {include_usage: true}`). */
export interface CompletionUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly total_tokens?: number
  /** DeepSeek-style cache accounting. */
  readonly prompt_cache_hit_tokens?: number
  /** Moonshot-style cache accounting. */
  readonly cached_tokens?: number
  /** OpenAI-native cache accounting. */
  readonly prompt_tokens_details?: { readonly cached_tokens?: number }
}

/** The vendor cached-token fallback chain, shared with the non-streaming
 *  parser — the gateway fronts upstreams with three cache vocabularies. */
export const usageFromCompletion = (usage: CompletionUsage | undefined) => ({
  inputTokens: usage?.prompt_tokens ?? 0,
  outputTokens: usage?.completion_tokens ?? 0,
  totalTokens: usage?.total_tokens ?? 0,
  cachedInputTokens:
    usage?.prompt_cache_hit_tokens ??
    usage?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0,
})

export const finishReasonFromWire = (
  raw: string | undefined,
): "stop" | "length" | "content-filter" | "tool-calls" => {
  if (raw === "tool_calls") return "tool-calls"
  if (raw === "length") return "length"
  if (raw === "content_filter") return "content-filter"
  return "stop"
}

/** One `data:` chunk of a streaming chat completion. */
interface StreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string | null
    readonly delta?: {
      readonly content?: string | null
      /** DeepSeek-native vocabulary (kimi-k2.7-code, deepseek serve this). */
      readonly reasoning_content?: string | null
      /** OpenRouter-style vocabulary (kimi-k2.6 via Moonshot serves this). */
      readonly reasoning?: string | null
      readonly tool_calls?: ReadonlyArray<{
        readonly index?: number
        readonly id?: string
        readonly function?: { readonly name?: string; readonly arguments?: string }
      }>
    }
  }>
  readonly usage?: CompletionUsage | null
  readonly error?: unknown
}

interface ToolCallAccum {
  readonly id: string
  readonly name: string
  readonly args: string
}

interface SseState {
  /** The open text chunk's part id, when one is streaming. */
  readonly textOpen: Option.Option<string>
  readonly reasoningOpen: Option.Option<string>
  readonly textSeq: number
  readonly reasoningSeq: number
  /** Fragments merged by wire index — id/name land on the first fragment,
   *  arguments concatenate across the rest. Emitted whole at flush. */
  readonly toolCalls: ReadonlyArray<ToolCallAccum>
  readonly finishReason: Option.Option<string>
  readonly usage: Option.Option<CompletionUsage>
  readonly flushed: boolean
}

const initialState: SseState = {
  textOpen: Option.none(),
  reasoningOpen: Option.none(),
  textSeq: 0,
  reasoningSeq: 0,
  toolCalls: [],
  finishReason: Option.none(),
  usage: Option.none(),
  flushed: false,
}

type Part = Response.StreamPartEncoded
type Emit = readonly [SseState, ReadonlyArray<Part>]

const emitThen = (emit: Emit, f: (state: SseState) => Emit): Emit => {
  const [state, more] = f(emit[0])
  return [state, [...emit[1], ...more]]
}

const closeText = (state: SseState): Emit =>
  Option.match(state.textOpen, {
    onNone: () => [state, []],
    onSome: (id) => [{ ...state, textOpen: Option.none() }, [{ type: "text-end", id }]],
  })

const closeReasoning = (state: SseState): Emit =>
  Option.match(state.reasoningOpen, {
    onNone: () => [state, []],
    onSome: (id) => [
      { ...state, reasoningOpen: Option.none() },
      [{ type: "reasoning-end", id }],
    ],
  })

/** A reasoning delta closes any open text chunk (channel switch), opens a
 *  fresh reasoning chunk when none is streaming, and appends the delta. */
const emitReasoning = (state: SseState, delta: string): Emit =>
  emitThen(closeText(state), (closed) =>
    Option.match(closed.reasoningOpen, {
      onNone: () => {
        const id = `reasoning-${closed.reasoningSeq + 1}`
        return [
          { ...closed, reasoningOpen: Option.some(id), reasoningSeq: closed.reasoningSeq + 1 },
          [
            { type: "reasoning-start", id },
            { type: "reasoning-delta", id, delta },
          ],
        ]
      },
      onSome: (id) => [closed, [{ type: "reasoning-delta", id, delta }]],
    }),
  )

const emitText = (state: SseState, delta: string): Emit =>
  emitThen(closeReasoning(state), (closed) =>
    Option.match(closed.textOpen, {
      onNone: () => {
        const id = `text-${closed.textSeq + 1}`
        return [
          { ...closed, textOpen: Option.some(id), textSeq: closed.textSeq + 1 },
          [
            { type: "text-start", id },
            { type: "text-delta", id, delta },
          ],
        ]
      },
      onSome: (id) => [closed, [{ type: "text-delta", id, delta }]],
    }),
  )

const emptyAccum: ToolCallAccum = { id: "", name: "", args: "" }

const mergeToolFragment = (
  calls: ReadonlyArray<ToolCallAccum>,
  fragment: NonNullable<
    NonNullable<NonNullable<StreamChunk["choices"]>[number]["delta"]>["tool_calls"]
  >[number],
): ReadonlyArray<ToolCallAccum> => {
  const index = fragment.index ?? 0
  const padded =
    calls.length > index
      ? calls
      : [...calls, ...Array.from({ length: index + 1 - calls.length }, () => emptyAccum)]
  return padded.map((call, at) =>
    at === index
      ? {
          id: call.id.length > 0 ? call.id : (fragment.id ?? ""),
          name: call.name.length > 0 ? call.name : (fragment.function?.name ?? ""),
          args: call.args + (fragment.function?.arguments ?? ""),
        }
      : call,
  )
}

const malformed = (moduleName: string, description: string): AiError.MalformedOutput =>
  new AiError.MalformedOutput({ module: moduleName, method: "streamText", description })

const applyChunk = (
  moduleName: string,
  state: SseState,
  chunk: StreamChunk,
): Effect.Effect<Emit, AiError.AiError> => {
  if (chunk.error !== undefined && chunk.error !== null) {
    return Effect.fail(
      new AiError.UnknownError({
        module: moduleName,
        method: "streamText",
        description: `the stream carried an error chunk: ${JSON.stringify(chunk.error).slice(0, 500)}`,
      }),
    )
  }
  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  const reasoning = delta?.reasoning_content ?? delta?.reasoning
  const content = delta?.content
  const afterReasoning: Emit =
    typeof reasoning === "string" && reasoning.length > 0
      ? emitReasoning(state, reasoning)
      : [state, []]
  const afterText: Emit = emitThen(afterReasoning, (s) =>
    typeof content === "string" && content.length > 0 ? emitText(s, content) : [s, []],
  )
  const [folded, parts] = afterText
  const next: SseState = {
    ...folded,
    toolCalls: (delta?.tool_calls ?? []).reduce(mergeToolFragment, folded.toolCalls),
    finishReason:
      typeof choice?.finish_reason === "string"
        ? Option.some(choice.finish_reason)
        : folded.finishReason,
    usage: chunk.usage !== null && chunk.usage !== undefined ? Option.some(chunk.usage) : folded.usage,
  }
  return Effect.succeed([next, parts])
}

/** The end-of-stream flush: close open chunks, emit the accumulated tool
 *  calls (unparseable arguments are a MalformedOutput — the loop's
 *  corrective path), then the finish with the folded usage. */
const flush = (moduleName: string, state: SseState): Effect.Effect<Emit, AiError.AiError> =>
  state.flushed
    ? Effect.succeed([state, []])
    : Effect.gen(function* () {
        const [closed, closeParts] = emitThen(closeText(state), closeReasoning)
        const toolParts = yield* Effect.forEach(closed.toolCalls, (call, index) =>
          Effect.try({
            try: (): Part => ({
              type: "tool-call",
              id: call.id.length > 0 ? call.id : `call_${index}`,
              name: call.name,
              params: JSON.parse(call.args.length > 0 ? call.args : "{}") as unknown,
            }),
            catch: () =>
              malformed(
                moduleName,
                `tool call ${call.name.length > 0 ? call.name : "?"} carried unparseable JSON arguments`,
              ),
          }),
        )
        const finish: Part = {
          type: "finish",
          reason:
            toolParts.length > 0
              ? "tool-calls"
              : finishReasonFromWire(Option.getOrUndefined(closed.finishReason)),
          usage: usageFromCompletion(Option.getOrUndefined(closed.usage)),
        }
        return [
          { ...closed, flushed: true },
          [...closeParts, ...toolParts, finish],
        ] as const
      })

/** The wire sentinel; also injected once at end-of-stream so the flush never
 *  depends on the gateway actually sending it. */
const DONE = "[DONE]"

const step = (
  moduleName: string,
  state: SseState,
  payload: string,
): Effect.Effect<Emit, AiError.AiError> =>
  payload === DONE
    ? flush(moduleName, state)
    : Effect.try({
        try: () => JSON.parse(payload) as StreamChunk,
        catch: () => malformed(moduleName, `a data: line was not JSON: ${payload.slice(0, 200)}`),
      }).pipe(Effect.flatMap((chunk) => applyChunk(moduleName, state, chunk)))

/** Parse a streaming chat-completions body into encoded stream parts. */
export const sseStreamParts = (options: {
  readonly moduleName: string
  readonly body: ReadableStream<Uint8Array>
}): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.fromReadableStream({
    evaluate: () => options.body,
    onError: (cause) =>
      new AiError.UnknownError({
        module: options.moduleName,
        method: "streamText",
        description: `the response body stream failed: ${String(cause)}`,
        cause,
      }),
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filterMap((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith("data:")
        ? Option.some(trimmed.slice("data:".length).trim())
        : Option.none()
    }),
    Stream.concat(Stream.succeed(DONE)),
    Stream.mapAccumEffect(initialState, (state, payload) =>
      step(options.moduleName, state, payload),
    ),
    Stream.flattenIterables,
  )
