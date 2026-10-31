import { AiError } from "effect/ai"
import type { Response } from "effect/ai"
import { Cause, Effect, Match, Option, Result, Schema, Stream } from "effect"
import { reasonOf } from "@xandreed/core"
import type { CompletionUsage, StreamChunk, StreamToolCall } from "./chat-wire.entity.js"
import { chunkErrorOf, decodeStreamChunk, decodeToolArguments, isQuotaExhausted } from "./chat-wire.entity.functions.js"
import { redactCredentials } from "../transport/http-proxy.entity.functions.js"
import { classifyAiError } from "./provider-failure.entity.functions.js"

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
export const usageFromCompletion = (usage: CompletionUsage | null | undefined, reading: UsageReading = {}): typeof Response.Usage.Encoded => {
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

/** The finish reasons that cut a response short, as `@effect/ai` names them. */
type WireCut = "length" | "content-filter" | "error" | "other"

/** A wire response's finish reason: one that ended on its own (`stop`, `tool-calls`) or a cut. */
export type WireFinishReason = "stop" | "tool-calls" | WireCut

/**
 * How a `finish_reason` word ends a response, read case-insensitively:
 * settled, the model ended its reply (`stop`, `tool_calls`,
 * `function_call`, `tool_use`, `tool_call`, `end_turn`, `stop_sequence`,
 * `eos`: the words OpenAI-compatible upstreams pass through from their
 * models, Anthropic's and Cohere's among them), or the cut it names
 * (`length` and `max_tokens`, the output limit; `content_filter`; `error`
 * and `insufficient_system_resource`). Any other word is the cut `other`.
 */
const endOfWord = (word: string): "settled" | WireCut =>
  Match.value(word.trim().toLowerCase()).pipe(
    Match.whenOr("stop", "tool_calls", "function_call", "tool_use", "tool_call", "end_turn", "stop_sequence", "eos", () => "settled" as const),
    Match.whenOr("length", "max_tokens", () => "length" as const),
    Match.when("content_filter", () => "content-filter" as const),
    Match.whenOr("error", "insufficient_system_resource", () => "error" as const),
    Match.orElse(() => "other" as const),
  )

/** A `finish_reason` that names something: absent, `null` and a blank word name nothing. */
const namedReason = (raw: string | null | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(raw), (word) => word.trim().length > 0)

/**
 * The wire's `finish_reason` as `@effect/ai`'s finish reason, for the settled
 * and the streamed parser alike, decided before any tool call's arguments are
 * read. A response that ended on its own (a settling word, or no reason at
 * all, as on a stream that ended without one) finishes on `tool-calls` when
 * it holds tool calls, else on `stop`. A cut stays a cut whatever the
 * response holds, so the loop runs no call of a cut reply.
 */
export const finishReasonFromWire = (raw: Option.Option<string>, hasToolCalls: boolean): WireFinishReason => {
  const end = Option.match(Option.flatMap(raw, namedReason), { onNone: () => "settled" as const, onSome: endOfWord })
  return end === "settled" ? (hasToolCalls ? "tool-calls" : "stop") : end
}

/**
 * A tool call's params from its wire arguments, once the response's finish
 * reason is known. Arguments that do not parse fail a response that ended on
 * its own with the model's invalid output (`invalid`: the loop's corrective
 * path). A cut response's call is kept with params `{}`: its arguments may
 * end mid-JSON, and the loop answers each call of a cut reply as cut and
 * never runs it.
 */
export const toolCallParams = (
  args: string,
  reason: WireFinishReason,
  invalid: () => AiError.AiError,
): Effect.Effect<Schema.Json, AiError.AiError> =>
  decodeToolArguments(args).pipe(
    Effect.catchTag("SchemaError", () =>
      reason === "stop" || reason === "tool-calls" ? Effect.fail(invalid()) : Effect.succeed({}),
    ),
  )

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
      classifyAiError(AiError.make({
        module: moduleName,
        method: "streamText",
        reason: isQuotaExhausted(Option.none(), error)
          ? new AiError.QuotaExhaustedError({ metadata: { [moduleName]: { ...Option.getOrElse(error, () => ({})) } } })
          : new AiError.UnknownError({
            description: `the stream carried an error chunk: ${JSON.stringify(chunk.error).slice(0, 500)}`,
            metadata: { [moduleName]: { ...Option.getOrElse(error, () => ({})) } },
          }),
      }), "compat"),
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
    // The last reason that names something: a blank one on a later chunk keeps it.
    finishReason: Option.orElse(namedReason(choice?.finish_reason), () => folded.finishReason),
    usage: chunk.usage !== null && chunk.usage !== undefined ? Option.some(chunk.usage) : folded.usage,
  }
  return Effect.succeed([next, parts])
}

/** The end-of-stream flush: close open chunks, decide the finish reason,
 *  emit the accumulated tool calls (unparseable arguments are an invalid
 *  output — the loop's corrective path — unless the reply was cut:
 *  `toolCallParams`), then the finish with the folded usage. */
const flush = (moduleName: string, reading: UsageReading, state: SseState): Effect.Effect<Emit, AiError.AiError> =>
  state.flushed
    ? Effect.succeed([state, []])
    : Effect.gen(function* () {
        const [closed, closeParts] = emitThen(closeText(state), closeReasoning)
        const reason = finishReasonFromWire(closed.finishReason, closed.toolCalls.length > 0)
        const toolParts = yield* Effect.forEach(closed.toolCalls, (call) =>
          toolCallParams(call.args.length > 0 ? call.args : "{}", reason, () =>
            malformed(moduleName, `tool call ${call.name.length > 0 ? call.name : "?"} carried unparseable JSON arguments`),
          ).pipe(
            Effect.map((params): Part => ({
              type: "tool-call",
              // Leave an omitted id for the loop's deterministic, session-scoped mint.
              id: call.id,
              name: call.name,
              params,
            })),
          ),
          { concurrency: 1 },
        )
        const finish: Part = {
          type: "finish",
          reason,
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
        reason: new AiError.UnknownError({ description: `the response body stream failed: ${redactCredentials(reasonOf(Cause.die(cause)))}` }),
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
