import { Duration, Effect, Layer, Match, Option, Result, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { ModelSpend } from "@xandreed/core/kernel"
import { chargedEffect, chargedSend, reaching } from "../model-spend/charge.adapter.js"
import type { Charging, Held } from "../model-spend/charge.adapter.js"
import { chargeOf, outputBoundOf, priceOf, unchargeable } from "../model-spend/model-spend.entity.functions.js"
import { DEFAULT_TIMEOUTS } from "../model-spend/model-spend.entity.js"
import type { Reported } from "../model-spend/model-spend.entity.js"
import { ANTHROPIC } from "./anthropic.entity.js"
import type { AnthropicOptions } from "./anthropic.entity.js"

/** What Anthropic counts for one message: its input without the cache's shares, which it counts apart. */
interface MessageUsage {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}

/** A message's usage in the charge's counts: the input with the cache's shares in it, as Effect AI counts it. */
const reportedOf = (usage: MessageUsage): Reported => {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return { input: (usage.input_tokens ?? 0) + cacheRead + cacheWrite, output: usage.output_tokens ?? 0, cacheRead, cacheWrite, billed: undefined }
}

const lostPartWay = (description: string) =>
  AiError.make({ module: ANTHROPIC, method: "streamText", reason: new AiError.InternalProviderError({ description }) })

/**
 * The events of a streamed message, watched for its usage: the input counted as it starts (`message_start`), and
 * the whole once its last delta comes (`message_delta`, whose counts are the message's so far), reported to the
 * charge then. A stream that ends before its `message_stop` fails the call, worth another try (Effect AI's provider
 * would end the answer there as if it were whole), and so does a wait between two events longer than `idle`.
 */
const watched = <E, R>(events: Stream.Stream<AnthropicClient.MessageStreamEvent, E, R>, report: Held["report"], idle: Duration.Duration) =>
  Stream.suspend(() => {
    let started: MessageUsage = {}
    let stopped = false
    return events.pipe(
      Stream.timeoutOrElse({ duration: idle, orElse: () => Stream.fail(lostPartWay(`no event of the answer came within ${Duration.format(idle)}`)) }),
      Stream.tap((event) => Match.value(event).pipe(
        Match.discriminators("type")({
          message_start: (start) => Effect.sync(() => { started = start.message.usage }),
          message_delta: (delta) => report(reportedOf({ ...started, ...Object.fromEntries(Object.entries(delta.usage).filter(([, value]) => value !== null && value !== undefined)) })),
          message_stop: () => Effect.sync(() => { stopped = true }),
        }),
        Match.orElse(() => Effect.void),
      )),
      Stream.concat(Stream.suspend(() => (stopped ? Stream.empty : Stream.fail(lostPartWay("the answer stopped before it was finished: the connection ended early"))))),
    )
  })

/**
 * A Claude model on Anthropic's own Messages API, as Effect AI's `LanguageModel`: Effect AI's Anthropic provider
 * (streaming, tool calls, the provider's errors as `AiError`s whose reasons say whether another try is worth it),
 * with prompt caching (`cache`) and every call charging the `ModelSpend` ledger in context (ADR 0026): the client's
 * two sends are wrapped, so a call's worst case (its body's size, its `max_tokens`) is held before the request
 * leaves, refused over the ledger's caps or for a model with no price, and settled at the usage Anthropic reported,
 * or at the hold once the request left. It sends over `fetch` (`FetchHttpClient`), on Node and on Bun; a host or a
 * test gives its own with `FetchHttpClient.Fetch`.
 *
 * @public
 */
export const anthropicModel = (options: AnthropicOptions): Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend> =>
  Layer.effect(LanguageModel.LanguageModel, Effect.gen(function* () {
    const spend = yield* ModelSpend
    const client = yield* AnthropicClient.make({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { apiUrl: options.baseUrl.replace(/\/+$/, "") }),
      transformClient: reaching(options.timeouts ?? {}),
    })
    const charging: Charging = { spend, options: options.spend, model: options.model, operation: "chat", module: ANTHROPIC }
    const idle = Duration.fromInputUnsafe(options.timeouts?.idle ?? DEFAULT_TIMEOUTS.idle)
    const bound = outputBoundOf(Option.fromNullishOr(options.maxOutputTokens), priceOf(options.spend, options.model))
    // What a request holds: its body's size, and the output cap it is sent with (the bound, which the model's config
    // sets; a call that gives none has the cap Effect AI gives the model), or a refusal before it is sent.
    const chargeFor = (payload: { readonly max_tokens: number }, method: string) =>
      Result.mapError(
        chargeOf(options.spend, options.model, new TextEncoder().encode(JSON.stringify(payload)).length, Option.map(bound, () => payload.max_tokens)),
        (why) => unchargeable(why, options.model, ANTHROPIC, method),
      )
    const charged = AnthropicClient.AnthropicClient.of({
      ...client,
      createMessage: (request) => Result.match(chargeFor(request.payload, "generateText"), {
        onFailure: Effect.fail,
        onSuccess: (charge) => chargedEffect(charging, "generateText", charge, (report) =>
          client.createMessage(request).pipe(Effect.tap(([body]) => report(reportedOf(body.usage))))),
      }),
      createMessageStream: (request) => Result.match(chargeFor(request.payload, "streamText"), {
        onFailure: Effect.fail,
        onSuccess: (charge) => chargedSend(charging, "streamText", charge, (report) =>
          Effect.map(client.createMessageStream(request), ([response, events]) => [response, watched(events, report, idle)])),
      }),
    })
    return yield* AnthropicLanguageModel.make({
      model: options.model,
      config: {
        ...Option.match(bound, { onNone: () => ({}), onSome: (cap) => ({ max_tokens: cap }) }),
        ...(options.cache === "off" ? {} : { cache_control: { type: "ephemeral", ...(options.cache === "1h" ? { ttl: "1h" } : {}) } }),
      },
    }).pipe(Effect.provideService(AnthropicClient.AnthropicClient, charged))
  })).pipe(Layer.provide(FetchHttpClient.layer))
