import { Duration, Schema } from "effect"
import type { Redacted } from "effect"
import type { SpendOptions, Timeouts } from "../model-spend/model-spend.entity.js"

/**
 * The text put before each text an embedder sends, by what it is embedded as (`EmbedAs`): e5's models read
 * `query: ` and `passage: `; OpenAI's and Gemini's want none. One left out is no text.
 *
 * @public
 */
export interface EmbedPrefixes {
  readonly query?: string
  readonly passage?: string
}

/**
 * What an embedder behind an OpenAI-compatible `/embeddings` endpoint is (`openAiCompatibleEmbedder`, ADR 0032).
 *
 * - `model`: the model id the endpoint takes (`text-embedding-3-small`, `google/gemini-embedding-001`), and the key of
 *   its price in `spend.prices`. An embedding model's price has `output: 0`: a call's worst case is its input alone.
 * - `baseUrl`: the API's base, to which `/embeddings` is added (`https://api.openai.com/v1`,
 *   `https://ai-gateway.vercel.sh/v1`).
 * - `apiKey`: sent as a bearer token, read from `Config` by the host (`Config.redacted`); none for an endpoint that
 *   takes no key (a local server).
 * - `dimensions`: the length of the vectors asked for (`dimensions` on the wire), for a model that cuts its vectors;
 *   none sends none, and the model gives its own length.
 * - `batch`: the most texts one request carries (`DEFAULT_BATCH`, 64); more are sent in several, one after another.
 * - `prefixes`: the text put before a question and before a kept text (`EmbedPrefixes`).
 * - `name`: the embedder's name (`Embedder.model`), which vectors are kept under. By default it is made of the model,
 *   the dimensions and the prefixes (`embedderNameOf`), so two configurations of one model never share vectors; a
 *   host that gives its own promises the same. 1 to `EMBEDDER_NAME_LIMIT` characters, no line break.
 * - `timeouts`: how long to wait for the headers (`response`) and then for the whole body (`idle`): five seconds
 *   each by default (`EMBEDDING_TIMEOUTS`), since a memory waits for its embeddings before every request it builds.
 * - `spend`: how each request charges the `ModelSpend` ledger in context (ADR 0026).
 * - `provider`: the name a call's span gives the provider (`gen_ai.provider.name`): `openai` by default.
 *
 * @public
 */
export interface OpenAiCompatibleEmbedderOptions {
  readonly model: string
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string>
  readonly dimensions?: number
  readonly batch?: number
  readonly prefixes?: EmbedPrefixes
  readonly name?: string
  readonly timeouts?: Timeouts
  readonly spend: SpendOptions
  readonly provider?: string
}

/**
 * The waits an embedder gives up after when its options name none: five seconds for the headers, five for the whole
 * body. A memory that ranks by meaning asks before every request it builds, and falls back to words when the embedder
 * fails, so a hung endpoint costs each context these seconds and no more; a host whose embeddings take longer gives
 * its own.
 *
 * @public
 */
export const EMBEDDING_TIMEOUTS = { response: Duration.seconds(5), idle: Duration.seconds(5) } as const

/** The most texts one request carries when the options name no `batch`: what Gemini's embeddings took on the gateway. */
export const DEFAULT_BATCH = 64

/**
 * The most characters of an embedder's name (`Embedder.model`): a vector's key is the name, a line feed and a text of
 * up to 300 characters, within the vector store's `KEY_LIMIT` (400), whole.
 *
 * @public
 */
export const EMBEDDER_NAME_LIMIT = 99

/** The `AiError` module this embedder's failures name. */
export const OPENAI_COMPATIBLE_EMBEDDER = "OpenAiCompatibleEmbedder"

/** A number a provider may send as a number or as text (the gateway's `cost`). */
const Amount = Schema.Union([Schema.Finite, Schema.FiniteFromString])
const Count = Schema.optional(Schema.NullOr(Schema.Finite))

/** What a provider counted for one request, and what it billed when it says (the gateway's `cost`, in USD). */
export const EmbeddingsUsage = Schema.Struct({
  prompt_tokens: Count,
  total_tokens: Count,
  cost: Schema.optional(Schema.NullOr(Amount)),
})
export type EmbeddingsUsage = typeof EmbeddingsUsage.Type

/** One response of the `/embeddings` wire, the fields read: a vector for each text, by its place, and the usage. */
export const EmbeddingsResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    embedding: Schema.Array(Schema.Number),
  })),
  usage: Schema.optional(Schema.NullOr(EmbeddingsUsage)),
})
export type EmbeddingsResponse = typeof EmbeddingsResponse.Type

/** A failed response's body as the wire gives it: an error with a message. */
export const EmbeddingsError = Schema.Struct({
  error: Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) }),
})
