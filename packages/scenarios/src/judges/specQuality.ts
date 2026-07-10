import { Effect, Schema } from "effect"
import { encodeSpecDocText } from "@xandreed/engine"
import type { SpecDoc } from "@xandreed/engine"
import type { Judge } from "../framework/model.js"

/**
 * The SPEC-QUALITY judge — an anchored 4-axis rubric over the refiner's
 * final draft (the qualities the deterministic checks cannot measure; the
 * mechanical ones — red-first, single-line commands — are hard checks in the
 * refiner pack, not judge work).
 */

export const SPEC_QUALITY_RUBRIC_VERSION = "1.0.0"

export const SpecGrades = Schema.parseJson(
  Schema.Struct({
    goal: Schema.Number,
    acceptance: Schema.Number,
    constraints: Schema.Number,
    scope: Schema.Number,
    summary: Schema.String,
  }),
)
export type SpecGrades = typeof SpecGrades.Type

export const specQualityRubric = (specText: string): string => `You are grading a SPEC a refiner agent produced for an unattended coding run. Score each axis 1-5 (5 = excellent):

- goal: ONE imperative paragraph — concrete about what exists when done, no vagueness, no essay.
- acceptance: every criterion is objectively checkable (by a command or by reading the code); nothing subjective like "clean" or "good".
- constraints: real fences (things that must NOT change / assumptions made), not restatements of the goal; absent constraints are fine when the task needs none — grade 5 for a justified absence.
- scope: sized for ONE implementor attempt; an oversized idea is staged with explicit non-goals.

THE SPEC:
${specText}

Reason briefly per axis, then end with EXACTLY one JSON object on the last line:
{"goal": n, "acceptance": n, "constraints": n, "scope": n, "summary": "one sentence"}`

export const lastSpecGradesJson = (text: string): string => {
  const start = text.lastIndexOf('{"goal"')
  return start >= 0 ? text.slice(start).trim() : text.trim()
}

const AXES = ["goal", "acceptance", "constraints", "scope"] as const

export const specGradesToScore = (grades: SpecGrades): number =>
  AXES.reduce((sum, axis) => sum + grades[axis], 0) / 20

export const makeSpecQualityJudge = <W>(options: {
  readonly doc: (world: W) => Effect.Effect<SpecDoc, unknown>
  readonly call: (prompt: string) => Effect.Effect<string, unknown>
}): Judge<W> => ({
  name: "spec-quality",
  run: (world) =>
    Effect.gen(function* () {
      const doc = yield* options.doc(world)
      const reply = yield* options.call(specQualityRubric(encodeSpecDocText(doc)))
      const grades = yield* Schema.decodeUnknown(SpecGrades)(lastSpecGradesJson(reply))
      return {
        score: specGradesToScore(grades),
        reason: `${grades.summary} — ${AXES.map((axis) => `${axis} ${grades[axis]}/5`).join(" · ")}`,
      }
    }),
})
