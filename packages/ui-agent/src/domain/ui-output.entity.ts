import { Schema } from "effect"

/** Immutable references: a release is never resolved through a latest alias. */
export const UiRelease = Schema.Struct({
  component: Schema.NonEmptyTrimmedString,
  version: Schema.NonEmptyTrimmedString,
  definitionHash: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  rendererRelease: Schema.NonEmptyTrimmedString,
  tokensHash: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  layoutVersion: Schema.NonEmptyTrimmedString,
})
export type UiRelease = typeof UiRelease.Type

/** IDs of facts/artifacts are resolved by the host, never executable content. */
export const UiOutputProposal = Schema.Struct({
  operationId: Schema.NonEmptyTrimmedString,
  nodeId: Schema.NonEmptyTrimmedString,
  release: UiRelease,
  props: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  evidence: Schema.Array(Schema.NonEmptyTrimmedString),
})
export type UiOutputProposal = typeof UiOutputProposal.Type

/** The host supplies these fields; the model cannot choose another principal/run. */
export const UiOutputScope = Schema.Struct({
  threadId: Schema.NonEmptyTrimmedString,
  runId: Schema.NonEmptyTrimmedString,
  messageId: Schema.NonEmptyTrimmedString,
  principalId: Schema.NonEmptyTrimmedString,
  fence: Schema.Int.pipe(Schema.positive()),
})
export type UiOutputScope = typeof UiOutputScope.Type

export const UiOutputReceipt = Schema.Struct({
  threadId: Schema.NonEmptyTrimmedString,
  messageId: Schema.NonEmptyTrimmedString,
  revisionId: Schema.NonEmptyTrimmedString,
  sequence: Schema.Int.pipe(Schema.positive()),
  nodeId: Schema.NonEmptyTrimmedString,
})
export type UiOutputReceipt = typeof UiOutputReceipt.Type

export class UiOutputError extends Schema.TaggedError<UiOutputError>()("UiOutputError", {
  code: Schema.Literal("invalid", "forbidden", "unavailable", "conflict", "storage"),
  message: Schema.String,
}) {}
