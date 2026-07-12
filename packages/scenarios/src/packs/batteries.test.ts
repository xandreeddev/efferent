import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect, Option, Ref } from "effect"
import { CandidateFact } from "@xandreed/smith"
import type { PackReport } from "../framework/model.js"
import { listCases } from "../live/fixtures.js"
import {
  calibrationSummary,
  judgeCalibrationPack,
  readJudgeCase,
  scenarioNameFor,
} from "./judgeCalibration.js"
import { digestPack, factCoverageJudge, readDigestCase } from "./digest.js"
import {
  extractionFidelityJudge,
  maximumOneToOneMatches,
  memoryPack,
  opMatches,
  readConsolidateCase,
  readExtractCase,
} from "./memory.js"

/**
 * The KEY-FREE half of the E2 batteries: every committed fixture decodes
 * (a malformed fixture fails CI, not the live run), the pack shapes hold,
 * and the scoring folds are proven against canned completions — the battery
 * LOGIC needs no key; only the live subject does.
 */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "smith", "fixtures")

describe("fixture decode (CI guards the committed goldens)", () => {
  test("every judge-golden case decodes and its workspace exists", async () => {
    const cases = listCases(join(FIXTURES, "judge-golden"))
    expect(cases.length).toBe(8)
    await Effect.runPromise(
      Effect.forEach(cases, (name) =>
        readJudgeCase(join(FIXTURES, "judge-golden"), name).pipe(
          Effect.tap((data) =>
            Effect.sync(() => {
              expect(["sound", "unsound"]).toContain(data.label)
              expect(scenarioNameFor(name).startsWith(`${data.label}:`)).toBe(true)
              expect(listCases(join(FIXTURES, "judge-golden", name)).includes("workspace")).toBe(true)
            }),
          ),
        ),
      ),
    )
  })

  test("every digest-golden case decodes with ≥1 mustRetain", async () => {
    const cases = listCases(join(FIXTURES, "digest-golden"))
    expect(cases.length).toBe(4)
    await Effect.runPromise(
      Effect.forEach(cases, (name) =>
        readDigestCase(join(FIXTURES, "digest-golden"), name).pipe(
          Effect.tap((data) =>
            Effect.sync(() => {
              expect(data.transcript.length).toBeGreaterThan(100)
              expect(data.expected.mustRetain.length).toBeGreaterThan(0)
            }),
          ),
        ),
      ),
    )
  })

  test("memory-golden + consolidate-golden decode", async () => {
    await Effect.runPromise(
      Effect.forEach(listCases(join(FIXTURES, "memory-golden")), (name) =>
        readExtractCase(join(FIXTURES, "memory-golden"), name),
      ),
    )
    await Effect.runPromise(
      Effect.forEach(listCases(join(FIXTURES, "consolidate-golden")), (name) =>
        readConsolidateCase(join(FIXTURES, "consolidate-golden"), name).pipe(
          Effect.tap((data) =>
            Effect.sync(() => {
              // Every expected op references a real candidate index.
              data.expected.forEach((e) => {
                expect(e.candidate).toBeGreaterThanOrEqual(1)
                expect(e.candidate).toBeLessThanOrEqual(data.candidates.length)
              })
            }),
          ),
        ),
      ),
    )
  })
})

describe("pack shapes", () => {
  test("judge-calibration: 8 stratified scenarios, k=3, versioned", () => {
    expect(judgeCalibrationPack.scenarios).toHaveLength(8)
    expect(judgeCalibrationPack.samples).toBe(3)
    expect(judgeCalibrationPack.meta?.["judge-prompt"]).toBeDefined()
    const names = judgeCalibrationPack.scenarios.map((s) => s.name)
    expect(new Set(names).size).toBe(8)
    expect(names.filter((n) => n.startsWith("sound:"))).toHaveLength(3)
    expect(names.filter((n) => n.startsWith("unsound:"))).toHaveLength(5)
  })

  test("digest: 4 scenarios, judge-heavy weighting; memory: extract + consolidate", () => {
    expect(digestPack.scenarios).toHaveLength(4)
    expect(digestPack.judgeWeight).toBe(0.8)
    const memoryNames = memoryPack.scenarios.map((s) => s.name)
    expect(memoryNames.filter((n) => n.startsWith("extract:"))).toHaveLength(2)
    expect(memoryNames.filter((n) => n.startsWith("consolidate:"))).toHaveLength(2)
  })
})

describe("scoring folds (canned completions — no keys)", () => {
  test("calibrationSummary derives false-block/false-pass from the prefixes", () => {
    const report: PackReport = {
      pack: "judge-calibration",
      mode: "live",
      scenarios: [
        { name: "sound:a", status: "ran", hardPassed: true, checks: [], judges: [], score: 1, combined: 1 },
        { name: "sound:b", status: "ran", hardPassed: true, checks: [], judges: [], score: 1, combined: 0.5 },
        { name: "unsound:c", status: "ran", hardPassed: true, checks: [], judges: [], score: 1, combined: 0 },
        { name: "skipped", status: "skipped", hardPassed: false, checks: [], judges: [], score: 0, combined: 0 },
      ],
      mean: 0.5,
      threshold: 0.8,
      passed: false,
    }
    const [line] = calibrationSummary(report)
    expect(line).toContain("false-block 0.25")
    expect(line).toContain("false-pass 1.00")
  })

  test("factCoverageJudge: retained/total − 0.25·inventions via canned probes", async () => {
    const world = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make("HANDOFF: the task is X; state is Y")
        return {
          transcript: "t",
          expected: {
            mustRetain: [
              { axis: "task" as const, fact: "the task is X" },
              { axis: "state" as const, fact: "state is Y" },
              { axis: "verification" as const, fact: "tests pass 9/9" },
            ],
            mustNotInvent: ["a database exists"],
          },
          digest: ref,
          generate: () => Effect.succeed("unused in this fold test"),
          // Canned: facts literally present in the handoff → yes; else no.
          complete: (prompt: string) =>
            Effect.succeed(
              /FACT: (the task is X|state is Y)\b/.test(prompt) ? "yes" : "no",
            ),
        }
      }),
    )
    const verdict = await Effect.runPromise(factCoverageJudge.run(world))
    expect(verdict.score).toBeCloseTo(2 / 3, 5)
    expect(verdict.reason).toContain("[verification]")
  })

  test("extractionFidelityJudge: independent one-to-one perfect matches score 1", async () => {
    const facts: ReadonlyArray<typeof CandidateFact.Type> = [
      { topic: "build-quirk", statement: "needs --preload" },
      { topic: "convention", statement: "kebab-case files" },
    ]
    const world = await Effect.runPromise(
      Effect.gen(function* () {
        const extracted = yield* Ref.make(Option.some(facts))
        return {
          transcript: "t",
          expected: {
            expected: [
              { topic: "build-quirk" as const, statement: "must run with --preload" },
              { topic: "convention" as const, statement: "file names are kebab-case" },
            ],
            distractors: [],
          },
          extracted,
          // Everything matches (perfect P=1, R=1 → score 1).
          generate: () => Effect.succeed("unused"),
          judge: () => Effect.succeed("yes"),
        }
      }),
    )
    const verdict = await Effect.runPromise(extractionFidelityJudge.run(world))
    expect(verdict.score).toBe(1)
  })

  test("memory equivalence matching cannot reuse one golden fact", () => {
    expect(maximumOneToOneMatches([[true], [true]])).toBe(1)
    expect(maximumOneToOneMatches([[true, false], [false, true]])).toBe(2)
  })

  test("opMatches: create by candidate index, corroborate/update by memory target", () => {
    const verbs = [
      { op: "create" as const, candidate: 2 },
      { op: "corroborate" as const, memory: 1 },
      { op: "update" as const, memory: 3, statement: "s" },
    ]
    expect(opMatches(verbs, { candidate: 2, op: "create" })).toBe(true)
    expect(opMatches(verbs, { candidate: 1, op: "create" })).toBe(false)
    expect(opMatches(verbs, { candidate: 1, op: "corroborate", memory: 1 })).toBe(true)
    expect(opMatches(verbs, { candidate: 1, op: "update", memory: 3 })).toBe(true)
    expect(opMatches(verbs, { candidate: 1, op: "update", memory: 2 })).toBe(false)
  })
})
