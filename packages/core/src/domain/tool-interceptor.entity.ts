import { Schema } from "effect"
import { Failure } from "./failure.entity.js"
import { ToolCallId } from "./message.entity.js"
import { InvocationId, RunRef } from "./run.entity.js"

/** One actual registry invocation, with no inferred run for direct calls. @public */
export const ToolInterceptIdentity = Schema.Struct({
  invocationId: InvocationId, tool: Schema.String, toolCallId: Schema.optionalKey(ToolCallId),
  run: Schema.OptionFromNullOr(RunRef), step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ToolInterceptIdentity = typeof ToolInterceptIdentity.Type

/** Schema-encoded outcome evidence; the final Toolkit encoding remains authoritative. @public */
export const ToolInterceptOutcome = Schema.Union([
  Schema.TaggedStruct("Success", { encoded: Schema.Json }),
  Schema.TaggedStruct("Failure", { encoded: Schema.Json }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ToolInterceptOutcome = typeof ToolInterceptOutcome.Type

/** Exact encoded arguments captured before the authored parameter codec. @public */
export const ToolInterceptBeforeInput = Schema.Struct({ ...ToolInterceptIdentity.fields, input: Schema.Json })
export type ToolInterceptBeforeInput = typeof ToolInterceptBeforeInput.Type

/** Effective encoded arguments and the actual handler candidate, detached from runtime values. @public */
export const ToolInterceptAfterInput = Schema.Struct({ ...ToolInterceptIdentity.fields, input: Schema.Json, outcome: ToolInterceptOutcome })
export type ToolInterceptAfterInput = typeof ToolInterceptAfterInput.Type

/** A validated host decision; Rewrite cannot retarget the tool. @public */
export const BeforeToolDecision = Schema.Union([
  Schema.TaggedStruct("Allow", {}),
  Schema.TaggedStruct("Deny", { failure: Failure }),
  Schema.TaggedStruct("Rewrite", { input: Schema.Json }),
  Schema.TaggedStruct("Respond", { outcome: ToolInterceptOutcome }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type BeforeToolDecision = typeof BeforeToolDecision.Type

/** Keep the actual candidate or substitute an authored schema-encoded outcome. @public */
export const AfterToolDecision = Schema.Union([
  Schema.TaggedStruct("Keep", {}),
  Schema.TaggedStruct("Replace", { outcome: ToolInterceptOutcome }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type AfterToolDecision = typeof AfterToolDecision.Type

/** The outcome class without a duplicate encoded answer. @public */
export const ToolInterceptOutcomeKind = Schema.Literals(["Success", "Failure"])
export type ToolInterceptOutcomeKind = typeof ToolInterceptOutcomeKind.Type

const BeforeAudit = Schema.Union([
  Schema.TaggedStruct("Allow", {}), Schema.TaggedStruct("Deny", { failure: Failure }),
  Schema.TaggedStruct("Rewrite", { input: Schema.Json }), Schema.TaggedStruct("Respond", { kind: ToolInterceptOutcomeKind }),
]).pipe(Schema.toTaggedUnion("_tag"))
const AfterAudit = Schema.Union([Schema.TaggedStruct("Keep", {}), Schema.TaggedStruct("Replace", { kind: ToolInterceptOutcomeKind })]).pipe(Schema.toTaggedUnion("_tag"))

/** Accepted decisions are audit facts, not proof of admission or handler execution. @public */
export const ToolInterceptAudit = Schema.Union([
  Schema.TaggedStruct("Before", { decision: BeforeAudit }), Schema.TaggedStruct("After", { decision: AfterAudit }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ToolInterceptAudit = typeof ToolInterceptAudit.Type

/** Result-scoped invocation identity and optional accepted Rewrite JSON, including null. @public */
export const ToolResultInterception = Schema.Struct({ invocationId: InvocationId, effectiveInput: Schema.optionalKey(Schema.Json) })
export type ToolResultInterception = typeof ToolResultInterception.Type
