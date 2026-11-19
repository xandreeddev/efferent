import { Effect, Layer, Ref } from "effect"
import type { Finding, FindingReport, PassNumber } from "./finding.entity.js"
import { Findings } from "./findings.port.js"

/** The findings of one review, kept in the process: each pass's numbered from 1, in the order they came. */
export const findingsInMemory: Layer.Layer<Findings> = Layer.effect(Findings, Effect.gen(function* () {
  const kept = yield* Ref.make<ReadonlyArray<Finding>>([])
  return Findings.of({
    record: (pass: PassNumber, report: FindingReport) => Ref.modify(kept, (all) => {
      const number = all.filter((finding) => finding.pass === pass).length + 1
      return [number, [...all, { ...report, pass, number }]]
    }),
    all: Ref.get(kept),
  })
}))
