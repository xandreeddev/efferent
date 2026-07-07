import { Predicate, Schema } from "effect"
import { GateName } from "./Brands.js"
import { Finding } from "./Finding.js"

/**
 * What one gate said about the workspace. `fail` REQUIRES at least one
 * finding — "failed with no reasons" is unrepresentable. `skip` names why
 * the gate never ran (an earlier cost rank failed), so a report always
 * accounts for every configured gate.
 */
export const PassVerdict = Schema.TaggedStruct("pass", {
  gate: GateName,
  durationMs: Schema.NonNegative,
  /** Advisory findings (warning/info) that did not fail the gate. */
  findings: Schema.Array(Finding),
})

export const FailVerdict = Schema.TaggedStruct("fail", {
  gate: GateName,
  durationMs: Schema.NonNegative,
  findings: Schema.NonEmptyArray(Finding),
})

export const SkipVerdict = Schema.TaggedStruct("skip", {
  gate: GateName,
  reason: Schema.NonEmptyString,
})

export const GateVerdict = Schema.Union(PassVerdict, FailVerdict, SkipVerdict)
export type GateVerdict = typeof GateVerdict.Type

/**
 * The ONE classification rule, in one place: a gate fails iff it produced
 * at least one error-severity finding. Gates report findings; the pipeline
 * judges them.
 */
export const toVerdict = (
  gate: GateName,
  durationMs: number,
  findings: ReadonlyArray<Finding>,
): GateVerdict => {
  const errors = findings.filter((f) => f.severity === "error")
  return Schema.is(Schema.NonEmptyArray(Finding))(errors)
    ? FailVerdict.make({ gate, durationMs, findings: errors })
    : PassVerdict.make({ gate, durationMs, findings })
}

export class GateReport extends Schema.Class<GateReport>("GateReport")({
  /** Pipeline order preserved; every configured gate appears exactly once. */
  verdicts: Schema.NonEmptyArray(GateVerdict),
}) {
  get ok(): boolean {
    return !this.verdicts.some(Predicate.isTagged("fail"))
  }

  get failures(): ReadonlyArray<typeof FailVerdict.Type> {
    return this.verdicts.filter((v): v is typeof FailVerdict.Type => v._tag === "fail")
  }
}
