import { AiError } from "effect/ai"
import type { Response } from "effect/ai"
import { Effect, Option, Result, Stream } from "effect"
import type { CompletionUsage, StreamChunk, StreamToolCall } from "./chat-wire.entity.js"
import { chunkErrorOf, decodeStreamChunk, decodeToolArguments, isQuotaExhausted } from "./chat-wire.entity.functions.js"

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
 *
 * Each chunk is decoded (`chat-wire.entity.ts`): a `data:` line that is no
 * chunk (not JSON, `null`, a field of the wrong type) fails the stream with
 * the provider's `InvalidResponseError`, never the model's invalid output.
 */

/** How a compat endpoint's usage is read. */
export interface UsageReading {
  /**
   * Read `completion_tokens_details.reasoning_tokens` (default true). The
   * built-in `google` provider sets false: Gemini's `completion_tokens` may
   * leave its thoughts out, which would break reasoning inside the output,
   * so its reasoning reads 0. Configured endpoints and `local` credentials
   * read it.
   */
  readonly reasoning?: boolean
}

/** The vendor cached-token fallback chain, shared with the non-streaming
 *  parser — the gateway fronts upstreams with three cache vocabularies.
 *  `prompt_tokens` already counts the cached and written tokens: it is the
 *  full input, and `completion_tokens` the full output, reasoning included. */
export const usageFromCompletion = (usage: CompletionUsage | null | undefined, reading: UsageReading = {}) => {
  const input = usage?.prompt_tokens ?? 0
  const cached =
    usage?.prompt_cache_hit_tokens ??
    usage?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0
  const written = usage?.prompt_tokens_details?.cache_write_tokens ?? 0
  const output = usage?.completion_tokens ?? 0
  const reasoning = reading.reasoning === false ? 0 : usage?.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    inputTokens: { total: input, uncached: Math.max(0, input - cached - written), cacheRead: cached, cacheWrite: written },
    outputTokens: { total: output, text: Math.max(0, output - reasoning), reasoning },
  }
}

export const finishReasonFromWire = (
  raw: string | null | undefined,
): "stop" | "length" | "content-filter" | "tool-calls" => {
  if (raw === "tool_calls") return "tool-calls"
  if (raw === "length") return "length"
  if (raw === "content_filter") return "content-filter"
  return "stop"
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
  fragment: StreamToolCall,
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

const malformed = (moduleName: string, description: string): AiError.AiError =>
  AiError.make({ module: moduleName, method: "streamText", reason: new AiError.InvalidOutputError({ description }) })

const applyChunk = (
  moduleName: string,
  state: SseState,
  chunk: StreamChunk,
): Effect.Effect<Emit, AiError.AiError> => {
  if (chunk.error !== undefined && chunk.error !== null) {
    const error = chunkErrorOf(chunk.error)
    return Effect.fail(
      AiError.make({
        module: moduleName,
        method: "streamText",
        reason: isQuotaExhausted(Option.none(), error)
          ? new AiError.QuotaExhaustedError({ metadata: { [moduleName]: { ...Option.getOrElse(error, () => ({})) } } })
          : new AiError.UnknownError({
            description: `the stream carried an error chunk: ${JSON.stringify(chunk.error).slice(0, 500)}`,
          }),
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
 *  calls (unparseable arguments are an invalid output — the loop's
 *  corrective path), then the finish with the folded usage. */
const flush = (moduleName: string, reading: UsageReading, state: SseState): Effect.Effect<Emit, AiError.AiError> =>
  state.flushed
    ? Effect.succeed([state, []])
    : Effect.gen(function* () {
        const [closed, closeParts] = emitThen(closeText(state), closeReasoning)
        const toolParts = yield* Effect.forEach(closed.toolCalls, (call, index) =>
          decodeToolArguments(call.args.length > 0 ? call.args : "{}").pipe(
            Effect.map((params): Part => ({
              type: "tool-call",
              id: call.id.length > 0 ? call.id : `call_${index}`,
              name: call.name,
              params,
            })),
            Effect.mapError(() =>
              malformed(
                moduleName,
                `tool call ${call.name.length > 0 ? call.name : "?"} carried unparseable JSON arguments`,
              ),
            ),
          ),
        )
        const finish: Part = {
          type: "finish",
          reason:
            toolParts.length > 0
              ? "tool-calls"
              : Option.match(closed.finishReason, { onNone: () => "stop" as const, onSome: finishReasonFromWire }),
          // No usage on the stream is a usage of nothing.
          usage: usageFromCompletion(Option.getOrElse(closed.usage, (): CompletionUsage => ({})), reading),
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
  reading: UsageReading,
  state: SseState,
  payload: string,
): Effect.Effect<Emit, AiError.AiError> =>
  payload === DONE
    ? flush(moduleName, reading, state)
    : decodeStreamChunk(moduleName, payload).pipe(Effect.flatMap((chunk) => applyChunk(moduleName, state, chunk)))

/** Parse a streaming chat-completions body into encoded stream parts. */
export const sseStreamParts = (options: {
  readonly moduleName: string
  readonly body: ReadableStream<Uint8Array>
  /** How the final chunk's usage is read (see `usageFromCompletion`). */
  readonly usage?: UsageReading
}): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.fromReadableStream({
    evaluate: () => options.body,
    onError: (cause) =>
      AiError.make({
        module: options.moduleName,
        method: "streamText",
        reason: new AiError.UnknownError({ description: `the response body stream failed: ${String(cause)}` }),
      }),
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filterMap((line: string) => {
      const trimmed = line.trim()
      return trimmed.startsWith("data:")
        ? Result.succeed(trimmed.slice("data:".length).trim())
        : Result.fail(line)
    }),
    Stream.concat(Stream.succeed(DONE)),
    // Each step's parts are emitted one by one.
    Stream.mapAccumEffect(() => initialState, (state, payload: string) =>
      step(options.moduleName, options.usage ?? {}, state, payload),
    ),
  )
