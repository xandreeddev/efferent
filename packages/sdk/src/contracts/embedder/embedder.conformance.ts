import { Array as Arr, Effect } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "@xandreed/core"
import { expect, fail, unexpected } from "../conformance.entity.functions.js"
import type { EmbedAs, EmbedFailed, Vector } from "./embedder.entity.js"
import { cosine, quoted } from "./embedder.entity.functions.js"
import type { Embedder } from "./embedder.port.js"

type EmbedderShape = Context.Service.Shape<typeof Embedder>

/**
 * An embedder as the kit opens it: a fresh one per check, released with its scope, and the texts the kit embeds.
 *
 * @public
 */
export interface EmbedderSubject {
  /**
   * Three or more texts of different meanings that the embedder embeds both as queries and as passages: any
   * sentences for a model, the recorded ones for `recordedEmbedder`.
   */
  readonly texts: ReadonlyArray<string>
  readonly open: Effect.Effect<EmbedderShape, never, Scope.Scope>
}

/**
 * The least cosine of a text's vector among others and its vector alone. A model may change a vector made in a batch
 * a little, never its direction: an 8-bit model scales its numbers for each batch, and e5-small-v2 (q8) gave 96 texts
 * batched at 0.9939 to 1 of their vectors alone (median 0.9974); at full precision it gave 1.
 */
const ALIKE = 0.99

/** The most any number of a text's vector may differ between two calls that ask for the same thing. */
const SAME = 1e-6

/** The one vector of a text alone. */
const alone = (embedder: EmbedderShape, check: string, text: string, as: EmbedAs): Effect.Effect<Vector, ConformanceFailure | EmbedFailed> =>
  Effect.flatMap(embedder.embed([text], as), (vectors) => vectors.length === 1 && vectors[0] !== undefined
    ? Effect.succeed(vectors[0])
    : fail(check, `${quoted(text)} alone, as a ${as}, gave ${vectors.length} vectors, not one`))

/** Where two vectors of one text differ by more than `SAME`, in words, or nothing. */
const differs = (first: Vector, second: Vector): string => {
  if (first.length !== second.length) return `one is ${first.length} numbers long and the other ${second.length}`
  const at = first.findIndex((x, index) => !(Math.abs(x - (second[index] ?? Number.NaN)) <= SAME))
  return at === -1 ? "" : `their numbers at ${at} are ${String(first[at])} and then ${String(second[at])}`
}

const checks: ReadonlyArray<readonly [string, string, (embedder: EmbedderShape, texts: ReadonlyArray<string>) => Effect.Effect<void, ConformanceFailure>]> = [
  ["order", "n texts give n vectors, in order, each pointing where the text's vector alone points", (embedder, texts) => Effect.gen(function* () {
    yield* expect("order", texts.length >= 3, `the subject gives ${texts.length} texts: the kit needs three or more`)
    const together = yield* embedder.embed(texts, "passage")
    yield* expect("order", together.length === texts.length, `${texts.length} texts embedded together gave ${together.length} vectors`)
    const each = yield* Effect.forEach(texts, (text) => alone(embedder, "order", text, "passage"), { concurrency: 1 })
    for (const [i, text] of texts.entries()) {
      for (const [j, other] of texts.entries()) {
        if (j <= i) continue
        const likeness = cosine(each[i] ?? [], each[j] ?? [])
        yield* expect("order", likeness < ALIKE, `${quoted(text)} and ${quoted(other)} gave vectors too alike to tell apart (cosine ${likeness.toFixed(4)}): give texts of different meanings`)
      }
      const likeness = cosine(together[i] ?? [], each[i] ?? [])
      yield* expect("order", likeness >= ALIKE, `the vector at ${i} of ${texts.length} texts embedded together is not the one ${quoted(text)} gives alone (cosine ${likeness.toFixed(4)})`)
    }
  }).pipe(unexpected("order"))],
  ["same", "a text gives the same vector each time it is embedded", (embedder, texts) => Effect.gen(function* () {
    const text = texts[0] ?? "kit"
    const first = yield* alone(embedder, "same", text, "query")
    const second = yield* alone(embedder, "same", text, "query")
    const where = differs(first, second)
    yield* expect("same", where === "", `${quoted(text)}, embedded twice as a query, gave two vectors: ${where}`)
  }).pipe(unexpected("same"))],
  ["dimension", "every vector is of one length, among others and alone", (embedder, texts) => Effect.gen(function* () {
    const together = yield* embedder.embed(texts, "query")
    const last = texts[texts.length - 1] ?? "kit"
    const lengths = Arr.dedupe([...together, yield* alone(embedder, "dimension", last, "query")].map((vector) => vector.length))
    yield* expect("dimension", lengths.length === 1, `the vectors of ${texts.length} texts, and of ${quoted(last)} alone, are ${lengths.join(", ")} numbers long, not one length`)
  }).pipe(unexpected("dimension"))],
  ["empty", "no texts give no vectors, and no failure", (embedder) => Effect.forEach(["query", "passage"] as const, (as) => Effect.matchEffect(embedder.embed([], as), {
    onFailure: (error) => fail("empty", `no texts, as a ${as}, failed with ${error._tag}: ${error.message}`),
    onSuccess: (vectors) => expect("empty", vectors.length === 0, `no texts, as a ${as}, gave ${vectors.length} vectors`),
  }), { concurrency: 1, discard: true })],
  ["both", "a text embeds as a query and as a passage, to vectors of one length", (embedder, texts) => Effect.gen(function* () {
    const text = texts[0] ?? "kit"
    const query = yield* alone(embedder, "both", text, "query")
    const passage = yield* alone(embedder, "both", text, "passage")
    yield* expect("both", query.length === passage.length, `${quoted(text)} is ${query.length} numbers long as a query and ${passage.length} as a passage: a question's vector must be comparable with a kept text's`)
  }).pipe(unexpected("both"))],
]

/**
 * The `Embedder` contract as checks (ADR 0021), each on a fresh embedder over the subject's texts: n texts give n
 * vectors in order, each pointing where its text's vector alone points (a cosine of at least 0.99: an 8-bit model scales
 * its numbers for each batch), the texts' own vectors being told apart (`order`); a text embedded twice gives the same
 * vector, each number within 0.000001 (`same`); every vector is of one length (`dimension`); no texts give no
 * vectors and no failure, as a query and as a passage (`empty`); a text embeds as a query and as a passage, to
 * vectors of one length, which may differ (`both`). A text the embedder cannot embed fails with `EmbedFailed`, which
 * fails the check that met it: the subject gives texts its embedder embeds.
 *
 * @public
 */
export const embedderConformance = (subject: EmbedderSubject): ReadonlyArray<ConformanceCheck> =>
  checks.map(([id, name, run]) => ({ id, name, run: Effect.scoped(Effect.flatMap(subject.open, (embedder) => run(embedder, subject.texts))) }))
