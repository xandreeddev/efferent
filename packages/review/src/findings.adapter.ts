import { Effect, Layer, Option, Ref } from "effect"
import type { CheckNumber, Finding, FindingReport, PassNumber, Verdict, VerdictReport } from "./finding.entity.js"
import { Findings } from "./findings.port.js"

/**
 * The findings and verdicts of one review, kept in the process: each pass's findings numbered from 1, in the order
 * they came; each check's first verdict.
 */
export const findingsInMemory: Layer.Layer<Findings> = Layer.effect(Findings, Effect.gen(function* () {
  const kept = yield* Ref.make<ReadonlyArray<Finding>>([])
  const verdicts = yield* Ref.make<ReadonlyMap<CheckNumber, Verdict>>(new Map())
  return Findings.of({
    record: (pass: PassNumber, report: FindingReport) => Ref.modify(kept, (all) => {
      const number = all.filter((finding) => finding.pass === pass).length + 1
      return [number, [...all, { ...report, pass, number }]]
    }),
    all: Ref.get(kept),
    judge: (check: CheckNumber, report: VerdictReport) => Ref.modify(verdicts, (all) =>
      all.has(check) ? [false, all] : [true, new Map([...all, [check, { ...report, check }]])]),
    verdictOf: (check: CheckNumber) => Effect.map(Ref.get(verdicts), (all) => Option.fromNullishOr(all.get(check))),
  })
}))
