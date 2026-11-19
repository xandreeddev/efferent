import { Effect, Layer, Option, Result } from "effect"
import { EmbedFailed } from "../../contracts/embedder/embedder.entity.js"
import type { EmbedAs, Vector } from "../../contracts/embedder/embedder.entity.js"
import { notAVector, quoted } from "../../contracts/embedder/embedder.entity.functions.js"
import { Embedder } from "../../contracts/embedder/embedder.port.js"

/**
 * The vectors `recordedEmbedder` answers with: each text's vector as a question (`query`) and as a text kept to be
 * found (`passage`), a map from the text to its vector for each. A text is embedded only as what it was recorded as.
 *
 * @public
 */
export interface RecordedVectors {
  readonly query: Readonly<Record<string, ReadonlyArray<number>>>
  readonly passage: Readonly<Record<string, ReadonlyArray<number>>>
}

/**
 * What `recordedEmbedder` is given: the name of the model that made the vectors, which they are kept under, and the
 * vectors.
 *
 * @public
 */
export interface RecordedOptions {
  readonly model: string
  readonly vectors: RecordedVectors
}

type Recorded = Readonly<Record<EmbedAs, ReadonlyMap<string, Vector>>>

/** The recording as maps, or why it is none: a model with no name, or vectors that are no vectors or of two lengths. */
const recordingOf = ({ model, vectors }: RecordedOptions): Result.Result<Recorded, string> => {
  if (model.trim().length === 0) return Result.fail("a model is named by one or more characters")
  let length = Option.none<number>()
  for (const as of ["query", "passage"] as const) {
    for (const [text, numbers] of Object.entries(vectors[as])) {
      const problem = notAVector(numbers)
      if (Option.isSome(problem)) return Result.fail(`the ${as} vector of ${quoted(text)} is no vector: ${problem.value}`)
      if (Option.isSome(length) && length.value !== numbers.length) {
        return Result.fail(`the ${as} vector of ${quoted(text)} is ${numbers.length} numbers long, and the vectors before it ${length.value}`)
      }
      length = Option.some(numbers.length)
    }
  }
  const mapOf = (recorded: Readonly<Record<string, ReadonlyArray<number>>>) => new Map(Object.entries(recorded).map(([text, numbers]) => [text, [...numbers]] as const))
  return Result.succeed({ query: mapOf(vectors.query), passage: mapOf(vectors.passage) })
}

/**
 * An embedder of recorded vectors (ADR 0021): for tests, and for a page that shows recall without a model. It answers
 * a text with the vector recorded for it as a query or as a passage, and fails any other with `EmbedFailed`, in
 * words that name the text (cut at 80 characters, with what was cut counted) and what it was asked as. Vectors that
 * are not all of one length, numbers that are no vector, or a model with no name, are refused where they are
 * written: it throws, as a definition does.
 *
 * @public
 */
export const recordedEmbedder = (options: RecordedOptions): Layer.Layer<Embedder> => {
  const recorded = Result.getOrThrowWith(recordingOf(options), (problem) => new Error(`recordedEmbedder: ${problem}`))
  return Layer.succeed(Embedder, Embedder.of({
    model: options.model,
    embed: (texts, as) => Effect.forEach(texts, (text) => {
      const vector = recorded[as].get(text)
      return vector === undefined
        ? Effect.fail(new EmbedFailed({ message: `No ${as} vector is recorded for ${quoted(text)}.` }))
        : Effect.succeed(vector)
    }, { concurrency: 1 }),
  }))
}
