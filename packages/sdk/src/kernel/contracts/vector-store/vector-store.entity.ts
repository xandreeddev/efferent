import { Schema } from "effect"
import { Vector } from "../embedder/embedder.entity.js"

/**
 * The most characters of a key in a `VectorStore`: room for a model's name and an item's text (a fact is at most 300
 * characters, a link's sentence at most 202).
 *
 * @public
 */
export const KEY_LIMIT = 400

/**
 * What a vector is kept under in a `VectorStore` (ADR 0021): a text of 1 to `KEY_LIMIT` characters, the caller's
 * own. A caller that keeps an index of the journal makes it from the embedder's model and the text it embedded,
 * never from an id: ids belong to one journal (the same sentence is `e10` in one and `e1` in another), so a key made
 * from one would miss a vector made ahead, or find another sentence's. Vectors of two models are never found as one
 * another's.
 *
 * @public
 */
export const VectorKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(KEY_LIMIT)).pipe(Schema.brand("VectorKey"))
export type VectorKey = typeof VectorKey.Type

/**
 * A vector to keep, under its key.
 *
 * @public
 */
export const VectorEntry = Schema.Struct({ key: VectorKey, vector: Vector })
export type VectorEntry = typeof VectorEntry.Type

/**
 * A key a search found, with how alike its vector is to the one searched for: their cosine, from -1 to 1.
 *
 * @public
 */
export const Scored = Schema.Struct({ key: VectorKey, score: Schema.Finite })
export type Scored = typeof Scored.Type

/**
 * What a search is asked for: at most `limit` keys (a whole number of at least 1), and, when `among` is given, only
 * keys of that list.
 *
 * @public
 */
export interface SearchOptions {
  readonly limit: number
  readonly among?: ReadonlyArray<VectorKey>
}

/**
 * Why a store refused a put or a search: a vector of another length than the store's (`dimension`), numbers that are
 * no vector (`vector`), a key that is no key (`key`), or a limit that is no whole number of at least 1 (`limit`).
 *
 * @public
 */
export const RefusedBecause = Schema.Literals(["dimension", "vector", "key", "limit"])
export type RefusedBecause = typeof RefusedBecause.Type

/**
 * A store refused a put or a search, and says why in words (`message`): a refused put keeps none of its entries.
 *
 * @public
 */
export class VectorsRefused extends Schema.TaggedError<VectorsRefused>()("VectorsRefused", {
  reason: RefusedBecause,
  message: Schema.String,
}) {}

/**
 * The medium that holds the vectors failed. The caller treats it as a defect of its call, as the files contract's
 * `FilesUnavailable` is: an index that cannot be read is no reason to send a request without saying so.
 *
 * @public
 */
export class VectorsUnavailable extends Schema.TaggedError<VectorsUnavailable>()("VectorsUnavailable", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
