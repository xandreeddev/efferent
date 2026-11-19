import { Duration, Effect, Layer, Match, Option, Redacted, Ref, Result, Schema } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientError } from "effect/http"
import { ModelSpend } from "@xandreed/core"
import type { EmbedAs, Vector } from "../../contracts/embedder/embedder.entity.js"
import { Embedder } from "../../contracts/embedder/embedder.port.js"
import { chargedEffect, reaching } from "../model-spend/charge.adapter.js"
import type { Charging } from "../model-spend/charge.adapter.js"
import type { CallReach } from "../model-spend/call-reach.port.js"
import { chargeOf, unchargeable } from "../model-spend/model-spend.entity.functions.js"
import type { Reported } from "../model-spend/model-spend.entity.js"
import { answeredWith, batchesOf, bodyOf, embedderNameOf, embedFailedOf, failedWith, optionsProblem, reportedOf, vectorsOf } from "./openai-compatible-embedder.entity.functions.js"
import { EMBEDDING_TIMEOUTS, EmbeddingsResponse, OPENAI_COMPATIBLE_EMBEDDER } from "./openai-compatible-embedder.entity.js"
import type { OpenAiCompatibleEmbedderOptions } from "./openai-compatible-embedder.entity.js"

const METHOD = "embed"

/** One request's answer: its vectors, and the input tokens the provider reported, when it did. */
interface Answered {
  readonly vectors: ReadonlyArray<Vector>
  readonly input: Option.Option<number>
}

/** A connection lost, refused or never answered, worth another try. */
const lost = (url: string, description: string) =>
  failedWith(new AiError.NetworkError({ reason: "TransportError", request: { method: "POST", url, urlParams: [], headers: {} }, description }))

/** The transport's failure as the embedder's: a bad address is final, anything else a lost connection. */
const transportFailure = (url: string) => (error: HttpClientError.HttpClientError): AiError.AiError => Match.value(error.reason).pipe(
  Match.tag("InvalidUrlError", (reason) => failedWith(new AiError.NetworkError({ reason: "InvalidUrlError", request: { method: "POST", url, urlParams: [], headers: {} }, description: reason.description ?? "the address is not one a request can be sent to" }))),
  Match.orElse((reason) => lost(url, reason.description ?? "the connection failed")),
)

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(EmbeddingsResponse))

/**
 * An `Embedder` behind an OpenAI-compatible `/embeddings` endpoint (ADR 0032): OpenAI's, the Vercel AI Gateway's
 * (Gemini's and OpenAI's models among others), a local server's. Texts are sent in requests of at most `batch`, one
 * after another, each after the prefix of what it is embedded as (`prefixes`), and each vector is made unit length,
 * since a model that cuts its vectors to fewer dimensions does not. Its `model` is the name its vectors are kept under
 * (`embedderNameOf`: the model, the dimensions and the prefixes), so two configurations never answer each other's
 * queries.
 *
 * Every request charges the `ModelSpend` ledger in context as a model provider does (ADR 0026): its worst case, the
 * body's bytes as input tokens at the model's input price (an embedding has no output, so its price's `output` is 0),
 * is held before it is sent, refused over the ledger's caps or for a model with no price, and settled at what the
 * provider billed, else its reported usage at the price, else at the hold once the request left. A failure is
 * `EmbedFailed` in words: the ledger's refusal keeps its `ModelSpendExceeded` as the cause (`isSpendRefusal` reads
 * it), any other failure an `AiError` whose reason says whether another try is worth it. No texts send nothing.
 *
 * Each `embed` is the span `openai_compatible_embedder.embed` (`gen_ai.operation.name` `embeddings`, the provider, the
 * model, the input tokens reported), and the charge counts each request as a model call (ADR 0030); no text it embeds
 * is put on a span. Options that make no embedder die where the layer is built. It sends over `fetch`
 * (`FetchHttpClient`), on Node and on Bun; a host or a test gives its own with `FetchHttpClient.Fetch`.
 *
 * @public
 */
export const openAiCompatibleEmbedder = (options: OpenAiCompatibleEmbedderOptions): Layer.Layer<Embedder, never, ModelSpend> =>
  Layer.effect(Embedder, Effect.gen(function* () {
    const problem = optionsProblem(options)
    if (Option.isSome(problem)) return yield* Effect.die(new Error(`openAiCompatibleEmbedder: ${problem.value}`))
    const spend = yield* ModelSpend
    const client = reaching({ response: options.timeouts?.response ?? EMBEDDING_TIMEOUTS.response })(yield* HttpClient.HttpClient)
    const charging: Charging = { spend, options: options.spend, model: options.model, operation: "embeddings", module: OPENAI_COMPATIBLE_EMBEDDER }
    const url = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`
    const idle = Duration.fromInputUnsafe(options.timeouts?.idle ?? EMBEDDING_TIMEOUTS.idle)
    const headers = options.apiKey === undefined ? {} : { authorization: `Bearer ${Redacted.value(options.apiKey)}` }
    const name = embedderNameOf(options)
    const failed = embedFailedOf(name)

    /** A whole answer read as vectors: the usage reported to the charge first, then the vectors checked. */
    const answered = (text: string, count: number, report: (reported: Reported) => Effect.Effect<void>): Effect.Effect<Answered, AiError.AiError> =>
      Option.match(decodeResponse(text), {
        onNone: () => Effect.fail(failedWith(new AiError.InvalidOutputError({ description: "the provider's answer is no list of embeddings" }))),
        onSome: (decoded) => Option.match(reportedOf(decoded.usage), { onNone: () => Effect.void, onSome: report }).pipe(
          Effect.andThen(Result.match(vectorsOf(decoded, count, options.dimensions), {
            onFailure: (why) => Effect.fail(failedWith(new AiError.InvalidOutputError({ description: why }))),
            onSuccess: (vectors) => Effect.succeed({ vectors, input: Option.map(reportedOf(decoded.usage), (reported) => reported.input) }),
          })),
        ),
      })

    /**
     * One request's vectors, charged. A refusal is the provider's whatever its body says: one whose body cannot be read
     * within `idle` is answered by its status alone. A whole answer's body is read within `idle`, or the connection is
     * taken as lost.
     */
    const send = (body: string, count: number, report: (reported: Reported) => Effect.Effect<void>): Effect.Effect<Answered, AiError.AiError, CallReach> => client.execute(
      HttpClientRequest.post(url, { headers, body: HttpBody.text(body, "application/json"), acceptJson: true }),
    ).pipe(
      Effect.mapError(transportFailure(url)),
      Effect.flatMap((response) => response.status >= 400
        ? Effect.flatMap(Effect.option(Effect.timeoutOption(response.text, idle)), (read) =>
          Effect.fail(answeredWith(response.status, Option.getOrElse(Option.flatten(read), () => ""))))
        : response.text.pipe(
          Effect.mapError(() => lost(url, "the connection was lost while the answer was read")),
          Effect.timeoutOrElse({ duration: idle, orElse: () => Effect.fail(lost(url, `the whole answer did not come within ${Duration.format(idle)}`)) }),
          Effect.flatMap((text) => answered(text, count, report)),
        )),
    )

    const request = (texts: ReadonlyArray<string>, as: EmbedAs): Effect.Effect<Answered, AiError.AiError> => {
      const body = bodyOf(options, texts, as)
      return Result.match(chargeOf(options.spend, options.model, new TextEncoder().encode(body).length, Option.some(0)), {
        onFailure: (why) => Effect.fail(unchargeable(why, options.model, OPENAI_COMPATIBLE_EMBEDDER, METHOD)),
        onSuccess: (charge) => chargedEffect(charging, METHOD, charge, (report) => send(body, texts.length, report)),
      })
    }

    const embed = Effect.fn("openai_compatible_embedder.embed", { kind: "client" })(function* (texts: ReadonlyArray<string>, as: EmbedAs) {
      if (texts.length === 0) return []
      yield* Effect.annotateCurrentSpan({
        "gen_ai.operation.name": "embeddings",
        "gen_ai.provider.name": options.provider ?? "openai",
        "gen_ai.request.model": options.model,
        ...(options.dimensions === undefined ? {} : { "gen_ai.embeddings.dimension.count": options.dimensions }),
      })
      const input = yield* Ref.make(Option.none<number>())
      const batches = yield* Effect.forEach(batchesOf(texts, options.batch), (batch) => request(batch, as).pipe(
        Effect.tap((answered) => Option.match(answered.input, {
          onNone: () => Effect.void,
          onSome: (tokens) => Ref.update(input, (sum) => Option.some(Option.getOrElse(sum, () => 0) + tokens)),
        })),
      ), { concurrency: 1 }).pipe(
        // The input tokens reported, on the span however the call ends: a backend sums what was spent.
        Effect.ensuring(Effect.flatMap(Ref.get(input), Option.match({
          onNone: () => Effect.void,
          onSome: (tokens) => Effect.annotateCurrentSpan("gen_ai.usage.input_tokens", tokens),
        }))),
        Effect.mapError(failed),
      )
      const vectors: ReadonlyArray<Vector> = batches.flatMap((answered) => answered.vectors)
      const lengths = new Set(vectors.map((vector) => vector.length))
      if (lengths.size > 1) {
        return yield* Effect.fail(failed(failedWith(new AiError.InvalidOutputError({ description: `the vectors of one call are ${[...lengths].join(" and ")} numbers long, not one length` }))))
      }
      return vectors
    })

    return Embedder.of({ model: name, embed })
  })).pipe(Layer.provide(FetchHttpClient.layer))
