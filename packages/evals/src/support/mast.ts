import { Effect, Either, Schema } from "effect"
import { Prompt } from "@effect/ai"
import { JudgeModel } from "../framework/judge.js"
import type { ScenarioRun } from "./scenarioRun.js"

/**
 * MAST — the Multi-Agent System failure Taxonomy (Cemri et al., Berkeley
 * arXiv:2503.13657): 14 failure modes in 3 categories, built from 1600+ traces.
 * Most multi-agent failures are DESIGN/COORDINATION, not weak models — so a
 * category histogram is a far better reliability KPI than a pass-rate alone.
 * We auto-classify a run's trajectory into these modes with the independent
 * judge (the paper's o1 classifier hit ~94% accuracy / κ=0.77).
 */
export const MAST_MODES = [
  { code: "FM-1.1", category: "FC1", label: "disobey task specification" },
  { code: "FM-1.2", category: "FC1", label: "disobey role specification" },
  { code: "FM-1.3", category: "FC1", label: "step repetition" },
  { code: "FM-1.4", category: "FC1", label: "loss of conversation history" },
  { code: "FM-1.5", category: "FC1", label: "unaware of termination conditions" },
  { code: "FM-2.1", category: "FC2", label: "conversation reset" },
  { code: "FM-2.2", category: "FC2", label: "fail to ask for clarification" },
  { code: "FM-2.3", category: "FC2", label: "task derailment" },
  { code: "FM-2.4", category: "FC2", label: "information withholding" },
  { code: "FM-2.5", category: "FC2", label: "ignored other agent's input" },
  { code: "FM-2.6", category: "FC2", label: "reasoning-action mismatch" },
  { code: "FM-3.1", category: "FC3", label: "premature termination" },
  { code: "FM-3.2", category: "FC3", label: "no or incomplete verification" },
  { code: "FM-3.3", category: "FC3", label: "incorrect verification" },
] as const

export type MastCategory = "FC1" | "FC2" | "FC3"

export interface MastVerdict {
  /** Detected failure-mode codes (e.g. ["FM-2.4", "FM-3.2"]). Empty ⇒ clean. */
  readonly modes: ReadonlyArray<string>
  /** Which categories were hit — the headline reliability dimensions. */
  readonly categories: Record<MastCategory, boolean>
}

const VALID = new Set<string>(MAST_MODES.map((m) => m.code))
const categoryOf = (code: string): MastCategory | undefined =>
  MAST_MODES.find((m) => m.code === code)?.category

const Reply = Schema.parseJson(Schema.Struct({ modes: Schema.optional(Schema.Array(Schema.String)) }))

/** Pure: parse a judge reply `{"modes":["FM-2.4",...]}` into a verdict. Unknown
 *  codes are dropped; unparseable input ⇒ clean (no false failures). */
export const parseMast = (text: string): MastVerdict => {
  const m = text.match(/\{[\s\S]*\}/)
  const empty: MastVerdict = { modes: [], categories: { FC1: false, FC2: false, FC3: false } }
  if (m === null) return empty
  return Either.match(Schema.decodeUnknownEither(Reply)(m[0]), {
    onLeft: () => empty,
    onRight: ({ modes }) => {
      const detected = [...new Set((modes ?? []).filter((c) => VALID.has(c)))]
      const categories = { FC1: false, FC2: false, FC3: false }
      for (const c of detected) {
        const cat = categoryOf(c)
        if (cat !== undefined) categories[cat] = true
      }
      return { modes: detected, categories }
    },
  })
}

/** A compact textual summary of a run for the classifier — trajectory shape +
 *  outcome, not the full transcript (cheap, and enough for category-level tags). */
export const runSummary = (output: ScenarioRun): string => {
  const t = output.trajectory
  const spawns = t.spawns
    .map((s) => `  - ${s.name} [${s.role}] ${s.ok ? "ok" : "FAILED"}, files=${s.filesChanged}`)
    .join("\n")
  const tests = output.testResult
    ? `tests: ${output.testResult.pass}/${output.testResult.pass + output.testResult.fail} pass (allPass=${output.testResult.allPass})`
    : "tests: n/a"
  return [
    `delegated: ${t.delegated} · usedCodeTier: ${t.usedCodeTier} · rootSteps: ${t.steps}`,
    `spawns (${t.spawns.length}):\n${spawns || "  (none)"}`,
    `perTierSpend: general=${t.perTierSpend.general} code=${t.perTierSpend.code} fast=${t.perTierSpend.fast}`,
    tests,
    `final message:\n${output.finalText.slice(0, 1500)}`,
  ].join("\n")
}

const TAXONOMY = MAST_MODES.map((m) => `${m.code} (${m.category}): ${m.label}`).join("\n")

/** Classify a run's trajectory into MAST failure modes using the independent judge. */
export const classifyMast = (output: ScenarioRun): Effect.Effect<MastVerdict, never, JudgeModel> =>
  Effect.gen(function* () {
    const judge = yield* JudgeModel
    const prompt = Prompt.make(
      "You analyse a MULTI-AGENT coding-agent run for failure modes using the MAST taxonomy.\n\n" +
        `MAST failure modes:\n${TAXONOMY}\n\n` +
        `RUN SUMMARY:\n${runSummary(output)}\n\n` +
        'Identify ONLY failure modes clearly evidenced by the summary (a clean run has none). ' +
        'Reply with ONLY JSON: {"modes": ["FM-x.y", ...]} (empty array if no failures).',
    )
    const res = yield* judge
      .generateText({ prompt })
      .pipe(Effect.catchAll(() => Effect.succeed({ text: "{}" })))
    return parseMast(res.text)
  })
