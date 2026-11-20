import { Effect, Layer, Option, Ref } from "effect"
import type { CheckNumber, Finding, FindingReport, TurnNumber, Verdict, VerdictReport } from "./finding.entity.js"
import { Findings } from "./findings.port.js"

/**
 * The findings and verdicts of reviews, kept in the process under each run: a run's findings numbered from 1 in each
 * turn, in the order they came; each check's first verdict.
 */
export const findingsInMemory: Layer.Layer<Findings> = Layer.effect(Findings, Effect.gen(function* () {
  const kept = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<Finding>>>(new Map())
  const verdicts = yield* Ref.make<ReadonlyMap<string, Verdict>>(new Map())
  const keyOf = (run: string, check: CheckNumber) => JSON.stringify([run, check])
  return Findings.of({
    record: (run: string, turn: TurnNumber, report: FindingReport) => Ref.modify(kept, (all) => {
      const ofRun = all.get(run) ?? []
      const number = ofRun.filter((finding) => finding.turn === turn).length + 1
      return [number, new Map([...all, [run, [...ofRun, { ...report, turn, number }]]])]
    }),
    all: (run: string) => Effect.map(Ref.get(kept), (all) => all.get(run) ?? []),
    judge: (run: string, check: CheckNumber, report: VerdictReport) => Ref.modify(verdicts, (all) =>
      all.has(keyOf(run, check)) ? [false, all] : [true, new Map([...all, [keyOf(run, check), { ...report, check }]])]),
    verdictOf: (run: string, check: CheckNumber) => Effect.map(Ref.get(verdicts), (all) => Option.fromNullishOr(all.get(keyOf(run, check)))),
  })
}))
