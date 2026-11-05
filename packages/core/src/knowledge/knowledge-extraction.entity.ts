import { Schema } from "effect"
import { KnowledgeAssertionId, KnowledgeEntityId, KnowledgeMemoryId, KnowledgeMemoryKind } from "./knowledge.entity.js"

const Key = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(160))
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Source offsets proposed by extraction; publication verifies the exact quote. @public */
export const KnowledgeExtractionSpan = Schema.Struct({ start: Offset, end: Offset, quote: Schema.String.check(Schema.isMinLength(1)) })
/** Local keys are resolved into stable source-scoped identities by the engine. @public */
export const KnowledgeExtractedEntity = Schema.Struct({
  key: Key, name: Key, type: Key, aliases: Schema.Array(Key),
  existing: Schema.OptionFromNullOr(KnowledgeEntityId),
  spans: Schema.Array(KnowledgeExtractionSpan).check(Schema.isNonEmpty()),
})
/** @public */
export const KnowledgeExtractedMemory = Schema.Struct({
  key: Key, kind: KnowledgeMemoryKind, text: Schema.Trimmed.check(Schema.isNonEmpty()),
  entities: Schema.Array(Key), spans: Schema.Array(KnowledgeExtractionSpan).check(Schema.isNonEmpty()),
  evidence: Schema.Union([
    Schema.TaggedStruct("Stated", {}),
    Schema.TaggedStruct("Inferred", { supports: Schema.Array(KnowledgeMemoryId).check(Schema.isNonEmpty()) }),
  ]),
  supersedes: Schema.Array(KnowledgeMemoryId),
})
/** @public */
export const KnowledgeExtractedAssertion = Schema.Struct({
  key: Key, subject: Key, predicate: Key,
  object: Schema.Union([Schema.TaggedStruct("Entity", { key: Key }), Schema.TaggedStruct("Value", { value: Schema.Json })]),
  text: Schema.Trimmed.check(Schema.isNonEmpty()), spans: Schema.Array(KnowledgeExtractionSpan).check(Schema.isNonEmpty()),
  validFrom: Schema.OptionFromNullOr(Offset), validTo: Schema.OptionFromNullOr(Offset),
  supersedes: Schema.Array(KnowledgeAssertionId),
  supersession: Schema.Literals(["change", "correction"]),
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
