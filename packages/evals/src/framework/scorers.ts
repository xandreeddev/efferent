import { AiError, Prompt } from "@effect/ai"
import { Effect, Either, Schedule, Schema } from "effect"
import { isTransientAiError } from "@xandreed/sdk-adapters"
import type { Scorer, ScorerArgs, ScoreResult } from "./Eval.js"
import { JudgeModel } from "./judge.js"

/** Pass/fail predicate — 1 if true, 0 if false. */
export const predicate = <I, O, T>(
  name: string,
  test: (a: ScorerArgs<I, O, T>) => boolean,
): Scorer<I, O, T> => ({
  name,
  score: (a) => Effect.sync(() => (test(a) ? 1 : 0)),
})

/**
 * Case-insensitive substring coverage: the fraction of `needles` present in
 * `haystack` (1 when there are no needles). Good for partial credit on "the
 * output should mention X, Y, Z".
 */
export const includesAll = <I, O, T>(
  name: string,
  pick: (a: ScorerArgs<I, O, T>) => {
    readonly haystack: string
    readonly needles: ReadonlyArray<string>
  },
): Scorer<I, O, T> => ({
  name,
  score: (a) =>
    Effect.sync(() => {
      const { haystack, needles } = pick(a)
      if (needles.length === 0) return 1
      const h = haystack.toLowerCase()
      const hit = needles.filter((n) => h.includes(n.toLowerCase())).length
      return hit / needles.length
    }),
})

/** Escape hatch: a scorer backed by an arbitrary Effect. */
export const fromEffect = <I, O, T, E, R>(
  name: string,
  score: (a: ScorerArgs<I, O, T>) => Effect.Effect<ScoreResult, E, R>,
): Scorer<I, O, T, E, R> => ({ name, score })

const JUDGE_SYSTEM =
  "You are a strict evaluator. Read the rubric and the candidate output, then " +
  "grade it. Be conservative: only award a high score when the output clearly " +
  "satisfies the rubric."

/** The judge's wire reply, decoded as a value — no JSON.parse, no try/catch. */
const JudgeReply = Schema.parseJson(
  Schema.Struct({
    score: Schema.optional(Schema.Unknown),
    reason: Schema.optional(Schema.String),
  }),
)

/** Tolerant JSON extraction: finds the LAST {...} block, strips markdown fences. */
const extractJson = (text: string): string | undefined => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced !== null && fenced[1] !== undefined) {
    const inner = fenced[1].trim()
    const m = inner.match(/\{[\s\S]*\}/)
    if (m !== null) return m[0]
  }
  const m = text.match(/\{[\s\S]*\}/g)
  if (m === null) return undefined
  // Last block is usually the JSON object (model may preamble).
  return m[m.length - 1]
}

const parseJudge = (text: string): ScoreResult => {
  const block = extractJson(text)
  if (block === undefined) return { score: 0, detail: "judge: no JSON in output" }
  return Either.match(Schema.decodeUnknownEither(JudgeReply)(block), {
    onLeft: (): ScoreResult => ({ score: 0, detail: "judge: unparseable JSON" }),
    onRight: ({ score, reason }): ScoreResult => {
      const raw = typeof score === "number" ? score : Number(score)
      const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
      return reason !== undefined ? { score: clamped, detail: reason } : { score: clamped }
    },
  })
}

/**
 * LLM-as-judge. `buildPrompt` returns the rubric + candidate as a single
 * string; the model is asked to reply with `{"score": 0..1, "reason": "…"}`.
 * Unparseable output scores 0. Runs on the {@link JudgeModel} — a strong,
 * INDEPENDENT grader (`--judge`) when configured, else the main model — never
 * the model under test, so its scores aren't inflated by self-preference bias.
 * Transient failures retry; a hard failure degrades to a 0 with the cause in the
 * detail (so a flaky gateway never silently corrupts the score).
 */
/** Retry schedule for transient LLM failures (429, timeout, etc.). */
const judgeRetry = Schedule.addDelay(Schedule.recurs(2), () => "1 second")

export const llmJudge = <I, O, T>(
  name: string,
  buildPrompt: (a: ScorerArgs<I, O, T>) => string,
): Scorer<I, O, T, unknown, JudgeModel> => ({
  name,
  score: (a) =>
    Effect.gen(function* () {
      const judge = yield* JudgeModel
      const prompt = Prompt.make(
        `${JUDGE_SYSTEM}\n\n${buildPrompt(a)}\n\n` +
          'Reply with ONLY a JSON object: {"score": <number between 0 and 1>, "reason": "<one sentence>"}.',
      )
      const res = yield* judge.generateText({ prompt }).pipe(
        Effect.retry({ schedule: judgeRetry, while: (e) => AiError.isAiError(e) && isTransientAiError(e) }),
        Effect.catchAll((e) => Effect.succeed({ text: ``, _tag: "judge-failed" as const, cause: String(e) })),
      )
      if ("_tag" in res && res._tag === "judge-failed") {
        return { score: 0, detail: `judge: ${res.cause}` }
      }
      return parseJudge(res.text)
    }),
})

/**
 * A graded quality judge: `llmJudge` with **anchored rubric levels** so scores
 * are comparable across cases/configs (not ad-hoc per prompt). The caller
 * supplies the case-specific `rubric` (what "good" means for this task) and the
 * `output` to grade (final answer and/or the produced files). The anchors
 * (1.0 / 0.75 / 0.5 / 0.25 / 0) are fixed here so a "0.5" means the same thing
 * everywhere — the property that makes the scorecard trend-able.
 */
export const qualityRubric = <I, O, T>(
  name: string,
  build: (a: ScorerArgs<I, O, T>) => { readonly rubric: string; readonly output: string },
): Scorer<I, O, T, unknown, JudgeModel> =>
  llmJudge(name, (a) => {
    const { rubric, output } = build(a)
    return [
      "Grade the candidate against the rubric using these ANCHORED levels:",
      "- 1.0  = fully satisfies — correct, complete, and tightly scoped.",
      "- 0.75 = correct with only minor issues.",
      "- 0.5  = partially correct, OR correct but with scope creep / a missing piece.",
      "- 0.25 = mostly wrong but contains some relevant work.",
      "- 0.0  = wrong, empty, or off-task.",
      "",
      `RUBRIC (what good looks like for THIS task):\n${rubric}`,
      "",
      `CANDIDATE OUTPUT:\n${output}`,
    ].join("\n")
  })
