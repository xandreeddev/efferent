import { Option, Predicate, Result, Schema } from "effect"
import { AiError } from "effect/ai"
import { EmbedFailed } from "../../contracts/embedder/embedder.entity.js"
import type { EmbedAs, Vector } from "../../contracts/embedder/embedder.entity.js"
import { notAVector } from "../../contracts/embedder/embedder.entity.functions.js"
import type { Reported } from "../model-spend/model-spend.entity.js"
import { spendRefusalOf } from "../model-spend/model-spend.entity.functions.js"
import { DEFAULT_BATCH, EMBEDDER_NAME_LIMIT, EmbeddingsError, OPENAI_COMPATIBLE_EMBEDDER } from "./openai-compatible-embedder.entity.js"
import type { EmbeddingsResponse, EmbeddingsUsage, EmbedPrefixes, OpenAiCompatibleEmbedderOptions } from "./openai-compatible-embedder.entity.js"

/** The text put before a text embedded as `as`: the options' prefix for it, else none. */
export const prefixOf = (prefixes: EmbedPrefixes | undefined, as: EmbedAs): string => prefixes?.[as] ?? ""

/**
 * The name an embedder's vectors are kept under (`Embedder.model`), made of what decides them: the model, the
 * dimensions asked for and the two prefixes, each part there only when it is given, the prefixes JSON-quoted so that
 * no two configurations make one name (`text-embedding-3-small dimensions=512`,
 * `e5 prefixes=["query: ","passage: "]`). A host's own `name` replaces it.
 */
export const embedderNameOf = (options: Pick<OpenAiCompatibleEmbedderOptions, "model" | "dimensions" | "prefixes" | "name">): string => {
  if (options.name !== undefined) return options.name
  const query = prefixOf(options.prefixes, "query")
  const passage = prefixOf(options.prefixes, "passage")
  return [
    options.model,
    ...(options.dimensions === undefined ? [] : [`dimensions=${options.dimensions}`]),
    ...(query === "" && passage === "" ? [] : [`prefixes=${JSON.stringify([query, passage])}`]),
  ].join(" ")
}

/** Why options make no embedder, in words, or nothing when they make one. */
export const optionsProblem = (options: OpenAiCompatibleEmbedderOptions): Option.Option<string> => {
  const name = embedderNameOf(options)
  if (options.model.trim().length === 0) return Option.some("a model is named by one or more characters")
  if (options.dimensions !== undefined && !(Number.isInteger(options.dimensions) && options.dimensions >= 1)) {
    return Option.some(`dimensions is a whole number of 1 or more, not ${options.dimensions}`)
  }
  if (options.batch !== undefined && !(Number.isInteger(options.batch) && options.batch >= 1)) {
    return Option.some(`batch is a whole number of 1 or more, not ${options.batch}`)
  }
  if (name.trim().length === 0) return Option.some("the name is one or more characters")
  if (/[\r\n]/.test(name)) return Option.some("the name holds a line break, and a vector's key is the name, a line feed and the text")
  if (name.length > EMBEDDER_NAME_LIMIT) {
    return Option.some(`the name ${JSON.stringify(name)} is ${name.length} characters, over ${EMBEDDER_NAME_LIMIT}: give the embedder a shorter name of its own (name), one no other configuration has`)
  }
  return Option.none()
}

/** The texts in requests of at most `batch` each, in order. */
export const batchesOf = <A>(texts: ReadonlyArray<A>, batch = DEFAULT_BATCH): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = []
  for (let at = 0; at < texts.length; at += batch) batches.push(texts.slice(at, at + batch))
  return batches
}

/**
 * The body of one request: the model, the texts each after its prefix, and the dimensions when the options name
 * them. Nothing else: the endpoint's own default encoding is a list of numbers.
 */
export const bodyOf = (options: OpenAiCompatibleEmbedderOptions, texts: ReadonlyArray<string>, as: EmbedAs): string => {
  const prefix = prefixOf(options.prefixes, as)
  return JSON.stringify({
    model: options.model,
    input: texts.map((text) => `${prefix}${text}`),
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
  })
}

/**
 * What a provider reported one request used, in the charge's counts: its input tokens (an embedding has no output),
 * with what it billed when it says; none when it said neither, which leaves the request's usage unknown, never zero.
 */
export const reportedOf = (usage: EmbeddingsUsage | null | undefined): Option.Option<Reported> => {
  if (usage === undefined || usage === null) return Option.none()
  const billed = usage.cost ?? undefined
  const input = usage.prompt_tokens ?? usage.total_tokens ?? undefined
  if (billed === undefined && input === undefined) return Option.none()
  return Option.some({ input: input ?? 0, output: 0, cacheRead: 0, cacheWrite: 0, billed })
}

/** A vector of unit length, pointing where `numbers` point; none for numbers that point nowhere (all zero). */
export const unitLength = (numbers: ReadonlyArray<number>): Option.Option<Vector> => {
  let squares = 0
  for (const x of numbers) squares += x * x
  const norm = Math.sqrt(squares)
  return norm > 0 && Number.isFinite(norm) ? Option.some(numbers.map((x) => x / norm)) : Option.none()
}

/**
 * The vectors of a response to `count` texts, in the texts' order (by each one's `index`), each made unit length, or
 * why the response gives none: a vector missing or given twice, numbers that are no vector or point nowhere, two
 * lengths, or a length other than the `dimensions` asked for.
 */
export const vectorsOf = (response: EmbeddingsResponse, count: number, dimensions: number | undefined): Result.Result<ReadonlyArray<Vector>, string> => {
  if (response.data.length !== count) return Result.fail(`the provider gave ${response.data.length} vectors for ${count} texts`)
  const byIndex = new Map(response.data.map((entry) => [entry.index, entry.embedding] as const))
  const vectors: Array<Vector> = []
  for (let index = 0; index < count; index++) {
    const numbers = byIndex.get(index)
    if (numbers === undefined) return Result.fail(`the provider gave no vector for the text at ${index}`)
    const problem = notAVector(numbers)
    if (Option.isSome(problem)) return Result.fail(`the vector of the text at ${index} is no vector: ${problem.value}`)
    if (dimensions !== undefined && numbers.length !== dimensions) {
      return Result.fail(`the vector of the text at ${index} is ${numbers.length} numbers long, not the ${dimensions} asked for`)
    }
    const first = vectors[0]
    if (first !== undefined && first.length !== numbers.length) {
      return Result.fail(`the vector of the text at ${index} is ${numbers.length} numbers long, and the one before it ${first.length}`)
    }
    const unit = unitLength(numbers)
    if (Option.isNone(unit)) return Result.fail(`the vector of the text at ${index} is all zeros, which points nowhere`)
    vectors.push(unit.value)
  }
  return Result.succeed(vectors)
}

/** The words of a failed response's body: its error's message when it is the wire's error, else its start. */
const saidIn = (body: string): string => Option.getOrElse(
  Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(EmbeddingsError))(body), (said) => Option.fromNullishOr(said.error.message)),
  () => body.slice(0, 300),
)

const METHOD = "embed"

/** A failure of this embedder's request, as an `AiError` whose reason says whether another try is worth it. */
export const failedWith = (reason: AiError.AiErrorReason): AiError.AiError => AiError.make({ module: OPENAI_COMPATIBLE_EMBEDDER, method: METHOD, reason })

/**
 * A refusal or failure the provider answered with: a key refused (401) or not allowed the model (403) and no credit
 * (402) are not worth another try; a rate limit (429), a request that outlived its wait (408) and the provider's own
 * failure (5xx) are; anything else is a request it will not take.
 */
export const answeredWith = (status: number, body: string): AiError.AiError => {
  const said = saidIn(body)
  const description = said.length > 0 ? said : `the provider answered ${status}`
  const reason = status === 401 ? new AiError.AuthenticationError({ kind: "InvalidKey", description })
    : status === 403 ? new AiError.AuthenticationError({ kind: "InsufficientPermissions", description })
      : status === 402 ? new AiError.QuotaExhaustedError({})
        : status === 429 ? new AiError.RateLimitError({})
          : status === 408 || status >= 500 ? new AiError.InternalProviderError({ description })
            : new AiError.InvalidRequestError({ description })
  return failedWith(reason)
}

/**
 * A request's failure as the contract's `EmbedFailed`, in words: a refusal of the spend ledger keeps the ledger's
 * `ModelSpendExceeded` as its cause (`spendRefusalOf` reads it there), any other failure the `AiError`, whose reason
 * says whether another try is worth it.
 */
export const embedFailedOf = (model: string) => (error: AiError.AiError): EmbedFailed => Option.match(spendRefusalOf(error), {
  onSome: (refusal) => new EmbedFailed({ message: `The texts were not embedded by ${model}: ${refusal.message}`, cause: refusal }),
  onNone: () => new EmbedFailed({ message: `The texts were not embedded by ${model}: ${wordsOf(error.reason)}`, cause: error }),
})

/** What a reason says: the words it was made with, else Effect AI's own for its kind (a rate limit, no credit). */
const wordsOf = (reason: AiError.AiErrorReason): string =>
  Predicate.hasProperty(reason, "description") && Predicate.isString(reason.description) && reason.description.length > 0 ? reason.description : reason.message
