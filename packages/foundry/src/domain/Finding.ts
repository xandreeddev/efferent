import { Schema } from "effect"
import { RuleId, WorkspacePath } from "./Brands.js"

export const Severity = Schema.Literal("error", "warning", "info")
export type Severity = typeof Severity.Type

export class SourceLocation extends Schema.Class<SourceLocation>("SourceLocation")({
  file: WorkspacePath,
  /** 1-based. */
  line: Schema.Int.pipe(Schema.positive()),
  /** 1-based. */
  column: Schema.Int.pipe(Schema.positive()),
}) {}

/**
 * One gate observation. Absence is `Option`, never `undefined`: a finding
 * without a location (e.g. a whole-project diagnostic) carries
 * `Option.none()`, and the wire shape stays a plain omitted field
 * (`optionalWith { as: "Option" }`).
 */
export class Finding extends Schema.Class<Finding>("Finding")({
  rule: RuleId,
  severity: Severity,
  message: Schema.NonEmptyString,
  location: Schema.optionalWith(SourceLocation, { as: "Option" }),
  /** How to fix it — rendered into the feedback brief for the implementor. */
  fixHint: Schema.optionalWith(Schema.NonEmptyString, { as: "Option" }),
}) {}
