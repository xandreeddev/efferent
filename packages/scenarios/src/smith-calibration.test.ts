import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { CalibrationReport, EvaluationTrial, decodeCandidates, validateCalibration } from "@xandreed/evals"
import { SessionLogEvent } from "@xandreed/core"
import { smithCodingDataset, smithCodingEvaluator } from "./smith-calibration.entity.functions.js"
import { makeSmithEvaluationStore, runSmithCalibration, smithCodingCalibration, smithInteractionCalibration } from "./smith-calibration.adapter.js"
import { SmithCodingEvidence } from "./smith-coding-trial.entity.js"

test("native Smith definitions have disjoint reviewed families and expose no solution or labels to subjects", async () => {
  await Effect.runPromise(validateCalibration(smithCodingCalibration))
  await Effect.runPromise(validateCalibration(smithInteractionCalibration))
  expect(smithCodingDataset.cases.map((entry) => entry.split)).toEqual(["calibration", "calibration", "validation", "validation"])
  expect(smithCodingDataset.cases.every((entry) => !Object.hasOwn(entry.input, "solution") && !Object.hasOwn(entry.input, "reference"))).toBe(true)
  const invalid = await Effect.runPromise(Effect.result(decodeCandidates(smithCodingCalibration, JSON.stringify([{ ...smithCodingCalibration.candidates[0], leakedReference: true }]))))
  expect(invalid._tag).toBe("Failure")
})

test("native calibration scores actual Smith trials, gates failed verification and durably exports authoritative sample ids", async () => {
  const reports = await Effect.runPromise(runSmithCalibration("smith-coding"))
  expect(reports.map((report) => report.run.split)).toEqual(["calibration", "validation"])
  expect(reports.flatMap((report) => report.trials)).toHaveLength(4)
  expect(reports.every((report) => report.reviewed && report.failures.length === 0 && report.candidates.every((candidate) => candidate.passed))).toBe(true)
  expect(reports.every((report) => Option.isNone(report.recommendation) && !report.promotionEligible)).toBe(true)
  const wire = await Effect.runPromise(Schema.encodeEffect(Schema.Array(CalibrationReport))(reports))
  const restored = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Array(CalibrationReport))(JSON.parse(JSON.stringify(wire))))
  expect(restored.flatMap((report) => report.trials)).toHaveLength(4)
  const trial = restored[0]!.trials[0]!
  const evidence = await Effect.runPromise(Schema.decodeUnknownEffect(SmithCodingEvidence)(Option.getOrThrow(trial.evidence)))
  const reference = smithCodingDataset.cases.find((entry) => entry.id === trial.caseId)!
  const failed = await Effect.runPromise(smithCodingEvaluator.run({ input: reference.input, reference: reference.reference, output: { ...evidence, checks: evidence.checks.filter((check) => check.name !== "production-verification") }, evidence }))
  expect(failed.metrics.find((metric) => metric.name === "acceptance")?.value).toBe(false)
  const directory = mkdtempSync(join(tmpdir(), "smith-native-ledger-"))
  await Effect.runPromise(Effect.gen(function* () {
    const ledger = yield* makeSmithEvaluationStore(directory)
    yield* ledger.store.writeTrial(trial)
    yield* ledger.store.writeTrial({ ...trial, id: EvaluationTrial.fields.id.make(`${trial.id}/repetition-2`), sample: 2 })
    const second = yield* Schema.decodeUnknownEffect(EvaluationTrial)(JSON.parse(readFileSync(join(directory, "native-trials", `${encodeURIComponent(`${trial.id}/repetition-2`)}.json`), "utf8")))
    const publicEvidence = yield* Schema.decodeUnknownEffect(SmithCodingEvidence)(JSON.parse(readFileSync(join(directory, `${evidence.candidate}.${trial.caseId}.2.json`), "utf8")))
    expect(second.sample).toBe(2)
    expect(publicEvidence.sample).toBe(2)
    expect(readdirSync(join(directory, "native-trials"))).toHaveLength(2)
    yield* Schema.decodeUnknownEffect(Schema.Array(SessionLogEvent))(publicEvidence.parentEvents)
    yield* Schema.decodeUnknownEffect(Schema.Array(SessionLogEvent))(publicEvidence.editorEvents)
    yield* ledger.store.writeTrial({ ...trial, evidence: Option.some({ ...evidence, candidate: "../outside", caseId: "../case" }), caseId: "../case" })
    expect(readdirSync(directory)).toContain("..%2Foutside...%2Fcase.1.json")
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
}, 180_000)
