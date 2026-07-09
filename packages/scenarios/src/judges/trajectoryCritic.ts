import { Effect, Schema } from "effect"
import type { Judge } from "../framework/model.js"

/**
 * The trajectory CRITIC as a reusable `Judge<W>` (agent-as-a-judge, the
 * Day-4 pattern): grade a run's PROCESS on the five axes the deterministic
 * gates cannot see. The caller supplies how to read the world (transcript +
 * outcome) and the model call — the rubric, parsing, and score fold live
 * here so the standalone CLI (`critic.ts`) and the live scenario packs grade
 * IDENTICALLY.
 */

/** Bump when the rubric text changes — recorded in pack meta + baselines so
 *  a score delta is attributable. */
export const CRITIC_RUBRIC_VERSION = "1.0.0"

export const Grades = Schema.parseJson(
  Schema.Struct({
    planning: Schema.Number,
    tool_selection: Schema.Number,
    interpretation: Schema.Number,
    efficiency: Schema.Number,
    robustness: Schema.Number,
    summary: Schema.String,
  }),
)
export type Grades = typeof Grades.Type

export const criticRubric = (transcript: string, outcome: string): string => `You are a trajectory CRITIC for a coding agent. Grade the PROCESS below — not the final code (deterministic gates already judged that). Score each axis 1-5 (5 = excellent):

- planning: was the reasoning coherent and goal-directed (no context pollution, no repetitive loops)?
- tool_selection: right tools, valid parameters, no unnecessary or hallucinated calls?
- interpretation: did the agent correctly read tool RESULTS — especially error states — and react to them?
- efficiency: steps proportionate to the task (no redundant calls, no thrash)?
- robustness: failures retried or reported honestly, never papered over?

Run outcome: ${outcome}

TRANSCRIPT:
${transcript}

Reason briefly per axis, then end with EXACTLY one JSON object on the last line:
{"planning": n, "tool_selection": n, "interpretation": n, "efficiency": n, "robustness": n, "summary": "one sentence"}`

/** The LAST {"planning"…} block — reasoning comes first by instruction. */
export const lastGradesJson = (text: string): string => {
  const start = text.lastIndexOf('{"planning"')
  return start >= 0 ? text.slice(start).trim() : text.trim()
}

const AXES = ["planning", "tool_selection", "interpretation", "efficiency", "robustness"] as const

/** Σ axes / 25 → 0..1 (each axis is 1..5). */
export const gradesToScore = (grades: Grades): number =>
  AXES.reduce((sum, axis) => sum + grades[axis], 0) / 25

export const gradesToReason = (grades: Grades): string =>
  `${grades.summary} — ${AXES.map((axis) => `${axis} ${grades[axis]}/5`).join(" · ")}`

export const makeTrajectoryCritic = <W>(options: {
  readonly transcript: (world: W) => Effect.Effect<string, unknown>
  readonly outcome: (world: W) => Effect.Effect<string, unknown>
  /** One strong-tier completion; failures are captured by the runner (a
   *  failing judge scores 0 with the failure as its reason). */
  readonly call: (prompt: string) => Effect.Effect<string, unknown>
}): Judge<W> => ({
  name: "trajectory-critic",
  run: (world) =>
    Effect.gen(function* () {
      const transcript = yield* options.transcript(world)
      const outcome = yield* options.outcome(world)
      const reply = yield* options.call(criticRubric(transcript, outcome))
      const grades = yield* Schema.decodeUnknown(Grades)(lastGradesJson(reply))
      return { score: gradesToScore(grades), reason: gradesToReason(grades) }
    }),
})
