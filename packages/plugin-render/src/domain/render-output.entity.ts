import { Schema } from "effect"

/** Immutable references: a release is never resolved through a latest alias. */
export const UiRelease = Schema.Struct({
  component: Schema.Trimmed.check(Schema.isNonEmpty()),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  definitionHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  rendererRelease: Schema.Trimmed.check(Schema.isNonEmpty()),
  tokensHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  layoutVersion: Schema.Trimmed.check(Schema.isNonEmpty()),
})
export type UiRelease = typeof UiRelease.Type

/** IDs of facts/artifacts are resolved by the host, never executable content. */
export const UiOutputProposal = Schema.Struct({
  operationId: Schema.Trimmed.check(Schema.isNonEmpty()),
  nodeId: Schema.Trimmed.check(Schema.isNonEmpty()),
  release: UiRelease,
  props: Schema.Record(Schema.String, Schema.Unknown),
  evidence: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
})
export type UiOutputProposal = typeof UiOutputProposal.Type

/** The host supplies these fields; the model cannot choose another principal/run. */
export const UiOutputScope = Schema.Struct({
  threadId: Schema.Trimmed.check(Schema.isNonEmpty()),
  runId: Schema.Trimmed.check(Schema.isNonEmpty()),
  messageId: Schema.Trimmed.check(Schema.isNonEmpty()),
  principalId: Schema.Trimmed.check(Schema.isNonEmpty()),
  fence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type UiOutputScope = typeof UiOutputScope.Type

export const UiOutputReceipt = Schema.Struct({
  threadId: Schema.Trimmed.check(Schema.isNonEmpty()),
  messageId: Schema.Trimmed.check(Schema.isNonEmpty()),
  revisionId: Schema.Trimmed.check(Schema.isNonEmpty()),
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  nodeId: Schema.Trimmed.check(Schema.isNonEmpty()),
})
export type UiOutputReceipt = typeof UiOutputReceipt.Type

export class UiOutputError extends Schema.TaggedError<UiOutputError>()("UiOutputError", {
  code: Schema.Literals(["invalid", "forbidden", "unavailable", "conflict", "storage"]),
  message: Schema.String,
}) {}
