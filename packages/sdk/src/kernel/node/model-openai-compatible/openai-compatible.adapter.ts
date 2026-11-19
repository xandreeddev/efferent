import { Duration, Effect, Layer, Match, Option, Redacted, Result, Stream } from "effect"
import type { Tracer } from "effect"
import { AiError, LanguageModel, Telemetry } from "effect/ai"
import type { Response } from "effect/ai"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientError } from "effect/http"
import { ModelSpend } from "@xandreed/core/kernel"
import { chargedStream, reaching } from "../model-spend/charge.adapter.js"
import type { Charging } from "../model-spend/charge.adapter.js"
import { chargeOf, outputBoundOf, priceOf, unchargeable } from "../model-spend/model-spend.entity.functions.js"
import { DEFAULT_TIMEOUTS } from "../model-spend/model-spend.entity.js"
import type { Reported } from "../model-spend/model-spend.entity.js"
import { REQUEST_FIELDS } from "./chat-wire.entity.js"
import type { Reading } from "./chat-wire.entity.js"
import { chunkOf, endReading, errorIn, failureOf, readChunk, reportedOf, settled, startReading, toolFieldsOf, wireMessages } from "./chat-wire.entity.functions.js"
import { OPENAI_COMPATIBLE } from "./openai-compatible.entity.js"
import type { OpenAiCompatibleOptions } from "./openai-compatible.entity.js"

const METHOD = "streamText"

const failed = (reason: AiError.AiErrorReason): AiError.AiError => AiError.make({ module: OPENAI_COMPATIBLE, method: METHOD, reason })

/** A request the provider was never sent: invalid as asked, not worth another try. */
const notSent = (description: string) => failed(new AiError.InvalidRequestError({ description }))

/** A connection lost, refused or never answered, worth another try. */
const lost = (url: string, description: string) =>
  failed(new AiError.NetworkError({ reason: "TransportError", request: { method: "POST", url, urlParams: [], headers: {} }, description }))

/** The transport's failure as the provider's: a bad address or body is final, anything else a lost connection. */
const transportFailure = (url: string) => (error: HttpClientError.HttpClientError): AiError.AiError => Match.value(error.reason).pipe(
  Match.tag("InvalidUrlError", (reason) => failed(new AiError.NetworkError({ reason: "InvalidUrlError", request: { method: "POST", url, urlParams: [], headers: {} }, description: reason.description ?? "the address is not one a request can be sent to" }))),
  Match.orElse((reason) => lost(url, reason.description ?? "the connection failed")),
)

/** What one part of an answer says on its call's span: the model that answered, or how it finished and what it counted. */
const annotated = (span: Tracer.Span, part: Response.StreamPartEncoded): void => {
  if (part.type === "response-metadata") Telemetry.addGenAIAnnotations(span, { response: { id: part.id, model: part.modelId } })
  if (part.type === "finish") {
    Telemetry.addGenAIAnnotations(span, {
      response: { finishReasons: [part.reason] },
      usage: { inputTokens: part.usage.inputTokens.total, outputTokens: part.usage.outputTokens.total },
    })
    // Cache counts are in `gen_ai.usage.input_tokens` too, as Effect AI's Anthropic provider counts them.
    if (part.usage.inputTokens.cacheRead !== undefined) span.attribute("gen_ai.usage.cache_read.input_tokens", part.usage.inputTokens.cacheRead)
    if (part.usage.inputTokens.cacheWrite !== undefined) span.attribute("gen_ai.usage.cache_write.input_tokens", part.usage.inputTokens.cacheWrite)
  }
}

/** The body of one call, or why it is not sent. */
const bodyOf = (options: OpenAiCompatibleOptions, provider: LanguageModel.ProviderOptions, bound: Option.Option<number>): Result.Result<string, AiError.AiError> => {
  if (provider.responseFormat.type === "json") return Result.fail(notSent("this provider sends no structured output: ask for text and read it"))
  const clash = Object.keys(options.extra ?? {}).filter((key) => REQUEST_FIELDS.includes(key))
  if (clash.length > 0) return Result.fail(notSent(`the extra body fields ${clash.join(", ")} are fields a request is made of, and are not sent`))
  return Result.match(wireMessages(provider.prompt), {
    onFailure: ({ part }) => Result.fail(notSent(`this provider sends text: a ${part} part of a user's message cannot be sent`)),
    onSuccess: (messages) => Result.succeed(JSON.stringify({
      model: options.model,
      messages,
      ...toolFieldsOf(provider.tools, provider.toolChoice),
      stream: true,
      stream_options: { include_usage: true },
      ...Option.match(bound, { onNone: () => ({}), onSome: (cap) => ({ [options.outputField ?? "max_tokens"]: cap }) }),
      ...options.extra,
    })),
  })
}

/**
 * The answer's stream read from the response's body: text handed on as it comes, each call whole at the end, the
 * usage reported to the charge once the answer is whole. A provider that fails part way, a connection that ends
 * before the answer's finish, a wait between two pieces longer than `idle`, and an answer cut before any word each
 * fail the call: an empty or half answer never ends as if it were whole.
 */
const answerOf = (body: Stream.Stream<Uint8Array, unknown>, url: string, idle: Duration.Duration, report: (reported: Reported) => Effect.Effect<void>): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.suspend(() => {
    let reading: Reading = startReading
    // What the provider reported is reported to the charge first, however the answer then ends.
    const end = Stream.unwrap(Effect.suspend(() => Option.match(reportedOf(reading.usage), { onNone: () => Effect.void, onSome: report }).pipe(
      Effect.map((): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
        if (reading.finish === undefined) return Stream.fail(lost(url, "the answer stopped before it was finished: the connection ended early"))
        if (reading.finish === "length" && !reading.text && reading.calls.size === 0) {
          return Stream.fail(failed(new AiError.UnknownError({ description: "the model used up its room for one answer before it wrote anything" })))
        }
        return Stream.fromIterable(endReading(reading))
      }),
    )))
    return body.pipe(
      Stream.timeoutOrElse({ duration: idle, orElse: () => Stream.fail(lost(url, `no piece of the answer came within ${Duration.format(idle)}`)) }),
      Stream.mapError((error) => (AiError.isAiError(error) ? error : lost(url, "the connection was lost part way through the answer"))),
      Stream.decodeText,
      Stream.splitLines,
      Stream.flatMap((line): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
        const data = line.startsWith("data:") ? line.slice(5).trim() : ""
        if (data.length === 0 || data === "[DONE]") return Stream.empty
        return Option.match(errorIn(data), {
          onSome: (words) => Stream.fail(failed(new AiError.InternalProviderError({ description: `the provider failed part way through the answer: ${words}` }))),
          onNone: () => Option.match(chunkOf(data), {
            onNone: () => Stream.empty,
            onSome: (chunk) => {
              const read = readChunk(reading, chunk)
              reading = read.reading
              return Stream.fromIterable(read.parts)
            },
          }),
        })
      }),
      Stream.concat(end),
    )
  })

/**
 * A model behind an OpenAI-compatible chat-completions endpoint, as Effect AI's `LanguageModel`: OpenAI, Gemini's
 * OpenAI-compatible endpoint, the Vercel AI Gateway. Streamed, with tool calls (handed on whole, in the order the
 * model asked), the provider's usage and, from the gateway, what it billed. Every call charges the `ModelSpend` ledger
 * in context (ADR 0026): its worst case is held before it is sent, refused over the ledger's caps or for a model with
 * no price, and settled at what the provider reported, or at the hold once the request left. A failure is an
 * `AiError` whose reason says whether another try is worth it (`retryable`). It sends over `fetch`
 * (`FetchHttpClient`), on Node and on Bun; a host or a test gives its own with `FetchHttpClient.Fetch`.
 *
 * @public
 */
export const openAiCompatibleModel = (options: OpenAiCompatibleOptions): Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend> =>
  Layer.effect(LanguageModel.LanguageModel, Effect.gen(function* () {
    const spend = yield* ModelSpend
    const client = reaching(options.timeouts ?? {})(yield* HttpClient.HttpClient)
    const charging: Charging = { spend, options: options.spend, model: options.model, module: OPENAI_COMPATIBLE }
    const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`
    const idle = Duration.fromInputUnsafe(options.timeouts?.idle ?? DEFAULT_TIMEOUTS.idle)
    const bound = outputBoundOf(Option.fromNullishOr(options.maxOutputTokens), priceOf(options.spend, options.model))
    const headers = options.apiKey === undefined ? {} : { authorization: `Bearer ${Redacted.value(options.apiKey)}` }
    const send = (body: string, report: (reported: Reported) => Effect.Effect<void>) => Stream.unwrap(
      client.execute(HttpClientRequest.post(url, { headers, body: HttpBody.text(body, "application/json"), acceptJson: false })).pipe(
        Effect.mapError(transportFailure(url)),
        Effect.flatMap((response) => response.status >= 400
          ? Effect.flatMap(Effect.option(response.text), (text) => Effect.fail(failureOf(OPENAI_COMPATIBLE, METHOD, response.status, Option.getOrElse(text, () => ""))))
          : Effect.succeed(Stream.concat(
            Stream.succeed<Response.StreamPartEncoded>({ type: "response-metadata", modelId: options.model }),
            answerOf(response.stream, url, idle, report),
          ))),
      ),
    )
    /**
     * The call's span (Effect AI's `LanguageModel.streamText`, which ends with the stream) given the attributes
     * OpenTelemetry names for a model call, the keys Effect AI's Anthropic provider sets: what was asked before it is
     * sent, then the model that answered, why it stopped and what it counted as each part arrives, so all of them are
     * on the span before it ends, however the stream ends.
     */
    const traced = <E, R>(span: Tracer.Span, answer: Stream.Stream<Response.StreamPartEncoded, E, R>) => Stream.suspend(() => {
      Telemetry.addGenAIAnnotations(span, {
        provider: { name: options.provider ?? "openai" },
        operation: { name: "chat" },
        request: { model: options.model, maxTokens: Option.getOrUndefined(bound) },
      })
      return answer.pipe(Stream.tap((part) => Effect.sync(() => annotated(span, part))))
    })
    const streamText = (provider: LanguageModel.ProviderOptions): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
      Result.match(bodyOf(options, provider, bound), {
        onFailure: (error) => Stream.fail(error),
        onSuccess: (body) => Result.match(chargeOf(options.spend, options.model, new TextEncoder().encode(body).length, bound), {
          onFailure: (why) => Stream.fail(unchargeable(why, options.model, OPENAI_COMPATIBLE, METHOD)),
          onSuccess: (charge) => traced(provider.span, chargedStream(charging, METHOD, charge, (report) => send(body, report))),
        }),
      })
    return yield* LanguageModel.make({
      // An answer asked for whole is the streamed one, collected: its text joined, its calls and its finish as they came.
      generateText: (provider) => Effect.map(Stream.runCollect(streamText(provider)), settled),
      streamText,
    })
  })).pipe(Layer.provide(FetchHttpClient.layer))
