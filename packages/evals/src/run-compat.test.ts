import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { EvaluationRun, executionFingerprint } from "./index.js"

/*
 * What a release stored must stay readable. Each `fixtures/run-<version>.json`
 * holds an evaluation run recorded from that release's code by
 * `scripts/record-run-fixture.ts`: the run as `execution.json` holds it and,
 * graded, as `report.json` holds it (its trials are the `trials/<id>.json`
 * files). This code decodes both with today's schemas; a change that breaks
 * one of them breaks every report that release wrote, and `grade`, `inspect`,
 * `compare`, `review` and `export` read those.
 */

const Fixture = Schema.Struct({
  format: Schema.Literal(1),
  version: Schema.String,
  execution: EvaluationRun,
  report: EvaluationRun,
})

const directory = join(import.meta.dir, "../fixtures")
const files = (await readdir(directory)).filter((name) => /^run-.+\.json$/.test(name)).sort()
const fixtures = await Effect.runPromise(Effect.forEach(files, (file) => Effect.tryPromise(() => Bun.file(join(directory, file)).json()).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Fixture)),
  Effect.map((fixture) => ({ file, fixture })),
), { concurrency: 1 }))

test("the evaluation runs of every release since 0.14.0 are kept", () => {
  expect(files).toContain("run-0.14.0.json")
  expect(fixtures.filter(({ file, fixture }) => file !== `run-${fixture.version}.json`).map(({ file }) => file)).toEqual([])
})

fixtures.forEach(({ fixture: { execution, report, version } }) => describe(`a ${version} evaluation run`, () => {
  test("decodes as an executed run and as its graded report", () => {
    expect([execution.phase, report.phase]).toEqual(["executed", "graded"])
    expect(report.trials.map((trial) => trial.id)).toEqual(execution.trials.map((trial) => trial.id))
    expect(execution.trials.every((trial) => trial.grades.length === 0)).toBe(true)
  })

  test("holds completed and failed trials with their transcripts, every metric kind and measured and unmeasured gates", () => {
    expect([...new Set(report.trials.map((trial) => trial.status))].sort()).toEqual(["completed", "error"])
    expect(report.trials.every((trial) => trial.transcript.length > 0 && trial.transcript.every((event, index) => event.sequence === index))).toBe(true)
    expect([...new Set(report.trials.flatMap((trial) => trial.grades.flatMap((grade) => grade.metrics.map((metric) => metric.kind))))].sort())
      .toEqual(["boolean", "preference", "probability", "score"])
    expect(report.gates.map((gate) => Option.isSome(gate.value))).toContain(true)
    expect(report.gates.map((gate) => Option.isSome(gate.value))).toContain(false)
    expect(report.failures.length).toBeGreaterThan(0)
  })

  test("its report still names its execution", () => {
    expect(report.fingerprints.sourceRun).toBe(execution.id)
    expect(report.fingerprints.sourceExecution).toBe(executionFingerprint(execution))
  })
}))
