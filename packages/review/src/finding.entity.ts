import { Schema } from "effect"

/** A line's number in a file, from 1. */
export const LineNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** What a finding is about: a bug, a security problem, or a broken rule of the repository's. */
export const FindingKind = Schema.Literals(["bug", "security", "rule"])
export type FindingKind = typeof FindingKind.Type

/** How much a finding matters, `high` first. */
export const Severity = Schema.Literals(["high", "medium", "low"])
export type Severity = typeof Severity.Type

/** The order findings are shown in: `high`, then `medium`, then `low`. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 }

/** The longest a finding's claim may be, in characters. */
export const CLAIM_LIMIT = 600

/** The longest a finding's quoted evidence may be, in characters. */
export const EVIDENCE_LIMIT = 1_000

/** Which pass of a review found something, from 1. */
export const PassNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("PassNumber"))
export type PassNumber = typeof PassNumber.Type

/**
 * What the model reports with `reportFinding`: the head's file and lines (`endLine` the last, when it spans more than
 * one), what kind of problem and how much it matters, the claim, and the evidence quoted from the head's file at those
 * lines. The model's own words: the host checks none of them yet.
 */
export const FindingReport = Schema.Struct({
  path: Schema.String,
  line: LineNumber,
  endLine: Schema.optionalKey(LineNumber),
  kind: FindingKind,
  severity: Severity,
  claim: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CLAIM_LIMIT)),
  evidence: Schema.String.check(Schema.isMaxLength(EVIDENCE_LIMIT)),
})
export type FindingReport = typeof FindingReport.Type

/** A finding as a review keeps it: what was reported, the pass that reported it and its number in that pass, from 1. */
export const Finding = Schema.Struct({
  ...FindingReport.fields,
  pass: PassNumber,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type Finding = typeof Finding.Type
