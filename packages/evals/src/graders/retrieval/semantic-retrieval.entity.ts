import { Schema } from "effect"
/** Names a retrieved document. */
export const RetrievalDocumentId = Schema.NonEmptyString.pipe(Schema.brand("RetrievalDocumentId"))
export type RetrievalDocumentId = typeof RetrievalDocumentId.Type
/** Names a unit the judge gives a verdict on (see `RetrievalItem`); the verdict carries it back. */
export const RetrievalItemId = Schema.NonEmptyString.pipe(Schema.brand("RetrievalItemId"))
export type RetrievalItemId = typeof RetrievalItemId.Type
export const RetrievalContext = Schema.Struct({ query: Schema.String, documents: Schema.Array(Schema.Struct({ id: RetrievalDocumentId, text: Schema.String, statements: Schema.Array(Schema.String) })), expectedClaims: Schema.Array(Schema.String) })
export type RetrievalContext = typeof RetrievalContext.Type
export const RetrievalJudgement = Schema.Struct({ verdicts: Schema.Array(Schema.Struct({ id: RetrievalItemId, relevant: Schema.Boolean, reason: Schema.String })) })
export type RetrievalJudgement = typeof RetrievalJudgement.Type
export const RetrievalMeasure = Schema.Literals(["contextual-precision", "contextual-recall", "contextual-relevancy"])
export type RetrievalMeasure = typeof RetrievalMeasure.Type
/**
 * One unit the judge gives a verdict on, by the id its verdict must carry:
 * a document (`<document id>`) for contextual precision, an expected claim
 * (`claim:<n>`) for contextual recall, a document's statement
 * (`<document id>/statement:<n>`) for contextual relevancy.
 */
export const RetrievalItem = Schema.Struct({ id: RetrievalItemId, text: Schema.String })
export type RetrievalItem = typeof RetrievalItem.Type
