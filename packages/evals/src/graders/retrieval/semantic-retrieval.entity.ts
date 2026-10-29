import { Schema } from "effect"
export const RetrievalContext = Schema.Struct({ query: Schema.String, documents: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, text: Schema.String, statements: Schema.Array(Schema.String) })), expectedClaims: Schema.Array(Schema.String) })
export type RetrievalContext = typeof RetrievalContext.Type
export const RetrievalJudgement = Schema.Struct({ verdicts: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, relevant: Schema.Boolean, reason: Schema.String })) })
export type RetrievalJudgement = typeof RetrievalJudgement.Type
export const RetrievalMeasure = Schema.Literals(["contextual-precision", "contextual-recall", "contextual-relevancy"])
export type RetrievalMeasure = typeof RetrievalMeasure.Type
/**
 * One unit the judge gives a verdict on, by the id its verdict must carry:
 * a document (`<document id>`) for contextual precision, an expected claim
 * (`claim:<n>`) for contextual recall, a document's statement
 * (`<document id>/statement:<n>`) for contextual relevancy.
 */
export const RetrievalItem = Schema.Struct({ id: Schema.NonEmptyString, text: Schema.String })
export type RetrievalItem = typeof RetrievalItem.Type
