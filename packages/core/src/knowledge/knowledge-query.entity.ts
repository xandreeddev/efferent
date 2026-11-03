import { Schema } from "effect"

const Query = Schema.Trimmed.check(Schema.isNonEmpty())
/** Bounded query planning; temporal coordinates remain explicit and independently optional. @public */
export const KnowledgeQueryPlan = Schema.Struct({
  queries: Schema.Array(Query).check(Schema.isNonEmpty(), Schema.isMaxLength(4)),
  entities: Schema.Array(Query).check(Schema.isMaxLength(16)),
  validAt: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  knownAt: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type KnowledgeQueryPlan = typeof KnowledgeQueryPlan.Type
/** A reranker can abstain by returning an empty order. @public */
export const KnowledgeRerank = Schema.Struct({ order: Schema.Array(Query).check(Schema.isMaxLength(100)) })
export type KnowledgeRerank = typeof KnowledgeRerank.Type
