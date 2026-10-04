import { mkdirSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { AssessmentError, CalibrationReport, EvaluationResult, EvaluationStore, EvaluationTrial, runCalibration } from "@xandreed/evals"
import { repositoryRoot } from "./smith-coding-fixture.adapter.js"
import { SmithCodingEvidence } from "./smith-coding-trial.entity.js"
import { makeSmithCodingCalibration, makeSmithInteractionCalibration } from "./smith-calibration.entity.functions.js"
import type { SmithCalibrationCandidate } from "./smith-calibration.entity.js"
import { SmithCalibrationRuntime } from "./smith-calibration-runtime.port.js"
import type { SmithCalibrationTransport } from "./smith-calibration-runtime.port.js"
import { runSmithCodingTrial } from "./smith-coding-trial.adapter.js"
import { runSmithInteractionTrial } from "./smith-interaction.adapter.js"

const failure = (error: { readonly message: string }) => new AssessmentError({ code: "provider", message: error.message })
const codingDefinition = (candidates: ReadonlyArray<SmithCalibrationCandidate> | undefined, mode: "scripted" | "live", transport: Option.Option<SmithCalibrationTransport>) => makeSmithCodingCalibration({
  task: (input) => SmithCalibrationRuntime.pipe(Effect.flatMap((runtime) => runSmithCodingTrial(input, runtime.candidate, 1, runtime.mode, runtime.transport)), Effect.mapError(failure), Effect.map((evidence) => ({ output: evidence, evidence }))),
  services: (candidate) => Layer.succeed(SmithCalibrationRuntime, { candidate, mode, transport }),
}, candidates)
export const smithCodingCalibration = codingDefinition(undefined, "scripted", Option.none())
export const smithInteractionCalibration = makeSmithInteractionCalibration({
  task: (input) => SmithCalibrationRuntime.pipe(Effect.flatMap((runtime) => runSmithInteractionTrial(input, runtime.candidate)), Effect.mapError(failure), Effect.map((evidence) => ({ output: evidence, evidence }))),
  services: (candidate) => Layer.succeed(SmithCalibrationRuntime, { candidate, mode: "scripted", transport: Option.none() }),
})

const codingEvidence = Schema.decodeUnknownOption(SmithCodingEvidence)
/** The native runner owns repetition identity; the isolated subject has no sample context. */
export const normalizeSmithTrial = (trial: EvaluationTrial): EvaluationTrial => {
  const normalize = (value: Option.Option<unknown>) => Option.map(value, (entry) => Option.match(codingEvidence(entry), { onNone: () => entry, onSome: (evidence) => ({ ...evidence, sample: trial.sample }) }))
  return { ...trial, output: normalize(trial.output), evidence: normalize(trial.evidence) }
}
const sanitize = (text: string) => text.replaceAll(repositoryRoot, "<efferent>").replaceAll(homedir(), "<home>")
const persist = (directory: string, name: string, value: unknown) => Effect.try({
  try: () => { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), `${sanitize(JSON.stringify(value, null, 2))}\n`) },
  catch: () => new AssessmentError({ code: "persistence", message: "Unable to persist Smith calibration evidence" }),
})
const wireError = () => new AssessmentError({ code: "persistence", message: "Unable to encode Smith calibration evidence" })
export const smithEvidenceFilename = (candidate: string, caseId: string, sample: number) => `${encodeURIComponent(candidate)}.${encodeURIComponent(caseId)}.${sample}.json`

/** A durable public-wire ledger, updated before and after each native assessment. */
export const makeSmithEvaluationStore = (directory: string) => Effect.gen(function* () {
  const recorded = yield* Ref.make<ReadonlyMap<string, EvaluationTrial>>(new Map())
  const store: typeof EvaluationStore.Service = {
    writeTrial: (raw) => Effect.gen(function* () {
      const trial = normalizeSmithTrial(raw)
      const encoded = yield* Schema.encodeEffect(EvaluationTrial)(trial).pipe(Effect.mapError(wireError))
      yield* persist(join(directory, "native-trials"), `${encodeURIComponent(trial.id)}.json`, encoded)
      const evidence = Option.flatMap(trial.evidence, codingEvidence)
      if (Option.isSome(evidence)) yield* persist(directory, smithEvidenceFilename(evidence.value.candidate, trial.caseId, trial.sample), evidence.value)
      yield* Ref.update(recorded, (prior) => new Map([...prior, [trial.id, trial]]))
    }),
    writeAssessment: (id, result) => Schema.encodeEffect(EvaluationResult)(result).pipe(Effect.mapError(wireError), Effect.flatMap((encoded) => persist(join(directory, "native-assessments"), `${encodeURIComponent(id)}.${encodeURIComponent(result.evaluator)}.json`, encoded))),
  }
  return { store, trials: Ref.get(recorded).pipe(Effect.map((all) => [...all.values()])) }
})

const persistRuns = (directory: string, run: (split: "calibration" | "validation") => Effect.Effect<CalibrationReport, AssessmentError, EvaluationStore>) => Effect.gen(function* () {
  const ledger = yield* makeSmithEvaluationStore(directory)
  const reports = yield* Effect.forEach(["calibration", "validation"] as const, (split) => run(split).pipe(Effect.provideService(EvaluationStore, ledger.store), Effect.map((report) => ({ ...report, trials: report.trials.map(normalizeSmithTrial) }))))
  const encoded = yield* Schema.encodeEffect(Schema.Array(CalibrationReport))(reports).pipe(Effect.mapError(wireError))
  yield* persist(directory, "calibration.json", encoded)
  yield* Effect.forEach(encoded, (report) => persist(directory, `calibration.${report.run.split}.json`, report))
  return { reports, trials: yield* ledger.trials }
})

export const runSmithCodingCalibrations = (directory: string, candidates: ReadonlyArray<SmithCalibrationCandidate>, mode: "scripted" | "live", transport: Option.Option<SmithCalibrationTransport>, repetitions: number) => {
  const definition = codingDefinition(candidates, mode, transport)
  return persistRuns(directory, (split) => runCalibration(definition, { runId: `smith-coding-${split}`, split, repetitions }))
}

/** Key-free CLI checks both disjoint fixture splits and retains genuine native reports. */
export const runSmithCalibration = (name: "smith-coding" | "smith-interaction"): Effect.Effect<ReadonlyArray<CalibrationReport>, AssessmentError> => {
  const directory = join(repositoryRoot, ".artifacts/evals/smith", `${name}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`)
  return persistRuns(directory, (split) => name === "smith-coding"
    ? runCalibration(smithCodingCalibration, { runId: `${name}-${split}`, split })
    : runCalibration(smithInteractionCalibration, { runId: `${name}-${split}`, split })).pipe(Effect.map(({ reports }) => reports))
}
