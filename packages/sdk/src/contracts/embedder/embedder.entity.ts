import { Schema } from "effect"

/**
 * A text as numbers (ADR 0021): one or more finite numbers, made by an `Embedder` from a text. Two vectors are
 * compared only when one model made both and they are of one length; how alike they are is their `cosine`.
 *
 * @public
 */
export const Vector = Schema.Array(Schema.Finite).check(Schema.isMinLength(1))
export type Vector = typeof Vector.Type

/**
 * What a text is embedded as: a question asked (`query`) or a text kept to be found (`passage`). Many models embed
 * the two differently (e5 among them, which reads a prefix for each), so a caller says which; a model that does not
 * tell them apart embeds both the same.
 *
 * @public
 */
export const EmbedAs = Schema.Literals(["query", "passage"])
export type EmbedAs = typeof EmbedAs.Type

/**
 * An embedder could not make the vectors it was asked for: a text it cannot embed, a model that is not loaded, a
 * service that did not answer. `message` says what failed, in words; `cause`, when there is one, is the failure
 * itself. No vector of that call was made.
 *
 * @public
 */
export class EmbedFailed extends Schema.TaggedError<EmbedFailed>()("EmbedFailed", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
