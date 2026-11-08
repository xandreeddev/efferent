import { Schema, SchemaTransformation } from "effect"
import { KnowledgeAssertionId, KnowledgeEntityId, KnowledgeMemoryId, KnowledgeMemoryKind, KnowledgeSupersession } from "./knowledge.entity.js"

const Key = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(160))
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
/** A local key a record names, which the extraction defines in `entities`; the output schema says so to the model. */
const EntityKey = (description: string) => Key.annotate({ description })
/** Why a record replaces those it supersedes, asked for only when it supersedes some; the output schema says so to the model. */
const Supersession = Schema.optionalKey(Schema.NullOr(KnowledgeSupersession).annotate({
  description: "Why this record replaces the records in supersedes: change when the situation changed, correction when the earlier record was wrong. Required when supersedes is non-empty; null when supersedes is empty.",
}))

/** Source offsets proposed by extraction; publication verifies the exact quote. @public */
export const KnowledgeExtractionSpan = Schema.Struct({ start: Offset, end: Offset, quote: Schema.String.check(Schema.isMinLength(1)) })
/** Local keys are resolved into stable source-scoped identities by the engine. @public */
export const KnowledgeExtractedEntity = Schema.Struct({
  key: Key, name: Key, type: Key, aliases: Schema.Array(Key),
  existing: Schema.OptionFromNullOr(KnowledgeEntityId),
  spans: Schema.Array(KnowledgeExtractionSpan).check(Schema.isNonEmpty()),
})
/**
 * A memory proposed by extraction; `entities` are keys the extraction defines in its `entities`
 * (the memory prompt asks that they never include the conversation's user, whom every memory is
 * about), and staging drops a memory that names an undefined key.
 * `supersession` says why it replaces every memory it `supersedes`
 * (`change` or `correction`). It is required only when `supersedes` is non-empty: null or absent
 * otherwise, and read only then (a value given beside an empty `supersedes` is ignored). Staging
 * drops a memory that supersedes records without it.
 * `restates` names active candidate memories the source states again without changing them (none
 * when absent): staging adds the source's spans to each as evidence instead of a new record.
 * `eventAt` is the time of the dated event the memory concerns, with `end` only for an event that
 * lasts beyond its start; null or absent when it concerns none. Staging drops a memory whose event
 * ends before it starts.
 * @public
 */
export const KnowledgeExtractedMemory = Schema.Struct({
  key: Key, kind: KnowledgeMemoryKind, text: Schema.Trimmed.check(Schema.isNonEmpty()),
  entities: Schema.Array(EntityKey("The key of an entity this memory concerns, defined in entities.")), spans: Schema.Array(KnowledgeExtractionSpan).check(Schema.isNonEmpty()),
  evidence: Schema.Union([
    Schema.TaggedStruct("Stated", {}),
    Schema.TaggedStruct("Inferred", { supports: Schema.Array(KnowledgeMemoryId).check(Schema.isNonEmpty()) }),
  ]),
  supersedes: Schema.Array(KnowledgeMemoryId),
  supersession: Supersession,
  restates: Schema.optionalKey(Schema.Array(KnowledgeMemoryId)),
  eventAt: Schema.optionalKey(Schema.NullOr(Schema.Struct({ start: Offset, end: Schema.optionalKey(Schema.NullOr(Offset)) }))),
})
/**
 * A relation proposed by extraction; `supersession` says why it replaces every relation it
 * `supersedes`: `change` (the world changed; each prior relation ends in a history copy) or
 * `correction` (the prior claim was wrong). It is required only when `supersedes` is non-empty:
 * null or absent otherwise, and read only then (a value given beside an empty `supersedes` is
 * ignored). Staging drops a relation that supersedes records without it.
 * @public
 */
export const KnowledgeExtractedAssertion = Schema.Struct({
  key: Key, subject: EntityKey("The key of the entity the relationship is about, defined in entities."), predicate: Key,
  object: Schema.Union([Schema.TaggedStruct("Entity", { key: EntityKey("The key of the related entity, defined in entities.") }), Schema.TaggedStruct("Value", { value: Schema.Json })]),
  text: Schema.Trimmed.check(Schema.isNonEmpty()), spans: Schema.Array(KnowledgeExtractionSpan).check(Schema.isNonEmpty()),
  validFrom: Schema.OptionFromNullOr(Offset), validTo: Schema.OptionFromNullOr(Offset),
  supersedes: Schema.Array(KnowledgeAssertionId),
  supersession: Supersession,
})
/** Provider-neutral extraction protocol shared by memory and opt-in document graphs. @public */
export const KnowledgeExtraction = Schema.Struct({
  entities: Schema.Array(KnowledgeExtractedEntity),
  memories: Schema.Array(KnowledgeExtractedMemory),
  assertions: Schema.Array(KnowledgeExtractedAssertion),
})
export type KnowledgeExtraction = typeof KnowledgeExtraction.Type
/**
 * The part of a source one extraction call reads: `[start, end)` in UTF-16
 * offsets of the whole source, part `part` of `parts`, counted from 1. The
 * windows of a source cover it in order, without gaps or overlap.
 * @public
 */
export const KnowledgeExtractionWindow = Schema.Struct({ part: Positive, parts: Positive, start: Offset, end: Offset })
export type KnowledgeExtractionWindow = typeof KnowledgeExtractionWindow.Type
/**
 * When extraction reviews its proposal against the source before staging (`extractKnowledge`).
 * `always`: every window's extraction is reviewed, a second helper call per window. `off`: none is.
 * Invalid extraction JSON or shape uses that window's one review when enabled; off fails strictly.
 * `on-failure`: decoded windows are extracted without review and their merge is staged; when
 * staging refuses it as a whole (`Invalid`: a repeated entity key, no record that survives its
 * checks), each window not already reviewed is reviewed and the reviewed merge staged. A record staging
 * drops on its own (a `RecordDropped` note) does not refuse the extraction, so it starts no
 * review. A boolean decodes as before: `true` is `always`, `false` is `off`.
 * @public
 */
export const KnowledgeReviewPolicy = Schema.Union([
  Schema.Literals(["always", "on-failure", "off"]),
  Schema.Boolean.pipe(Schema.decodeTo(Schema.Literals(["always", "off"]), SchemaTransformation.transform({
    decode: (review) => review ? "always" as const : "off" as const,
    encode: (policy) => policy === "always",
  }))),
])
export type KnowledgeReviewPolicy = typeof KnowledgeReviewPolicy.Type
