import { Schema } from "effect"
import { RunId } from "@xandreed/core"

/** Every render id is trimmed and non-empty; its brand says which id it is. */
const Id = Schema.Trimmed.check(Schema.isNonEmpty())

/**
 * The host's thread (a session, a conversation): a store never mixes records across threads.
 *
 * @public
 */
export const ThreadId = Id.pipe(Schema.brand("ThreadId"))
export type ThreadId = typeof ThreadId.Type

/**
 * Whom the output is for; the host authorizes it, and records never mix across principals.
 *
 * @public
 */
export const PrincipalId = Id.pipe(Schema.brand("PrincipalId"))
export type PrincipalId = typeof PrincipalId.Type

/**
 * The host's message a render answers (`<messageId>:v<generation>` names its versions).
 *
 * @public
 */
export const RenderMessageId = Id.pipe(Schema.brand("RenderMessageId"))
export type RenderMessageId = typeof RenderMessageId.Type

/**
 * One node of a snapshot, or the placeholder a fill commits into.
 *
 * @public
 */
export const NodeId = Id.pipe(Schema.brand("NodeId"))
export type NodeId = typeof NodeId.Type

/**
 * One commit, idempotent under it: a retry reuses the id (`operationIdOf`, `fillOperationIdOf`).
 *
 * @public
 */
export const OperationId = Id.pipe(Schema.brand("OperationId"))
export type OperationId = typeof OperationId.Type

/**
 * The immutable revision a commit stored, as the host's journal names it.
 *
 * @public
 */
export const RevisionId = Id.pipe(Schema.brand("RevisionId"))
export type RevisionId = typeof RevisionId.Type

/**
 * Immutable references: a release is never resolved through a latest alias.
 *
 * @public
 */
export const UiRelease = Schema.Struct({
  component: Schema.Trimmed.check(Schema.isNonEmpty()),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  definitionHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  rendererRelease: Schema.Trimmed.check(Schema.isNonEmpty()),
  tokensHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  layoutVersion: Schema.Trimmed.check(Schema.isNonEmpty()),
})
export type UiRelease = typeof UiRelease.Type

/**
 * IDs of facts/artifacts are resolved by the host, never executable content.
 *
 * @public
 */
export const UiOutputProposal = Schema.Struct({
  operationId: OperationId,
  nodeId: NodeId,
  release: UiRelease,
  props: Schema.JsonObject,
  evidence: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
})
export type UiOutputProposal = typeof UiOutputProposal.Type

/**
 * The host supplies these fields; the model cannot choose another principal/run.
 *
 * @public
 */
export const UiOutputScope = Schema.Struct({
  threadId: ThreadId,
  /** Core's run id, trimmed and non-empty as a scope takes it. */
  runId: RunId.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  messageId: RenderMessageId,
  principalId: PrincipalId,
  /**
   * The writer's lease on the message: a store refuses (`forbidden`) a write
   * whose fence is lower than the highest it accepted for the surface and message.
   */
  fence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type UiOutputScope = typeof UiOutputScope.Type

/** @public */
export const UiOutputReceipt = Schema.Struct({
  threadId: ThreadId,
  messageId: RenderMessageId,
  revisionId: RevisionId,
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  nodeId: NodeId,
})
export type UiOutputReceipt = typeof UiOutputReceipt.Type

/** @public */
export class UiOutputError extends Schema.TaggedError<UiOutputError>()("UiOutputError", {
  code: Schema.Literals(["invalid", "forbidden", "unavailable", "conflict", "storage"]),
  message: Schema.String,
}) {}
