import { Schema } from "effect"

export const SMITH_EDIT_SCHEMA_VERSION = "1"
export const WorkOrderId = Schema.NonEmptyString.pipe(Schema.brand("SmithWorkOrderId"))
export const ProposalId = Schema.NonEmptyString.pipe(Schema.brand("SmithProposalId"))
export class WorkOrder extends Schema.Class<WorkOrder>("SmithWorkOrder")({
  id: WorkOrderId,
  objective: Schema.NonEmptyString,
  paths: Schema.Array(Schema.NonEmptyString),
}) {}
export const ProposedChange = Schema.Struct({
  path: Schema.NonEmptyString,
  original: Schema.OptionFromNullOr(Schema.String),
  originalFingerprint: Schema.OptionFromNullOr(Schema.String),
  content: Schema.OptionFromNullOr(Schema.String),
})
export type ProposedChange = typeof ProposedChange.Type
export class EditProposal extends Schema.Class<EditProposal>("SmithEditProposal")({
  id: ProposalId,
  workOrderId: WorkOrderId,
  summary: Schema.String,
  changes: Schema.Array(ProposedChange),
}) {}
export const VerificationCheck = Schema.Struct({ command: Schema.String, stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Number })
export type VerificationCheck = typeof VerificationCheck.Type
export class EditReceipt extends Schema.Class<EditReceipt>("SmithEditReceipt")({
  proposalId: ProposalId,
  paths: Schema.Array(Schema.String),
  status: Schema.Literals(["applied", "empty"]),
}) {}
