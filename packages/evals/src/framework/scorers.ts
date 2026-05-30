import { LanguageModel, Prompt } from "@effect/ai"
import { Effect } from "effect"
import type { Scorer, ScorerArgs, ScoreResult } from "./Eval.js"

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

const parseJudge = (text: string): ScoreResult => {
  const m = text.match(/\{[\s\S]*\}/)
  if (m === null) return { score: 0, detail: "judge: no JSON in output" }
  try {
    const obj = JSON.parse(m[0]) as { readonly score?: unknown; readonly reason?: unknown }
    const raw = typeof obj.score === "number" ? obj.score : Number(obj.score)
    const score = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    const reason = typeof obj.reason === "string" ? obj.reason : undefined
    return reason !== undefined ? { score, detail: reason } : { score }
  } catch {
    return { score: 0, detail: "judge: unparseable JSON" }
  }
}

/**
 * LLM-as-judge. `buildPrompt` returns the rubric + candidate as a single
 * string; the model is asked to reply with `{"score": 0..1, "reason": "…"}`.
 * Unparseable output scores 0. Runs on whatever `LanguageModel` is in context
 * (the same router the agent uses) — no second key.
 */
export const llmJudge = <I, O, T>(
  name: string,
  buildPrompt: (a: ScorerArgs<I, O, T>) => string,
): Scorer<I, O, T, unknown, LanguageModel.LanguageModel> => ({
  name,
  score: (a) =>
    Effect.gen(function* () {
      const prompt = Prompt.make(
        `${JUDGE_SYSTEM}\n\n${buildPrompt(a)}\n\n` +
          'Reply with ONLY a JSON object: {"score": <number between 0 and 1>, "reason": "<one sentence>"}.',
      )
      const res = yield* LanguageModel.generateText({ prompt })
      return parseJudge(res.text)
    }),
})
