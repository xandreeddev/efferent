import type { LanguageModel } from "@effect/ai"
import { Context } from "effect"

/**
 * The model that backs the LLM-as-judge scorers. Deliberately a SEPARATE tag
 * from the agent's `LanguageModel`, so the judge can be a strong, INDEPENDENT
 * grader (a different model from the one under test) — the standard mitigation
 * for self-preference bias and for the loop-provider flakiness that can zero a
 * correct solution's quality score. The env provides it pinned to `--judge`
 * when set, else falls back to the main model (today's behaviour). Holds a raw
 * service so a scorer calls `judge.generateText(...)` directly, like a one-shot.
 */
export class JudgeModel extends Context.Tag("eval/JudgeModel")<JudgeModel, LanguageModel.Service>() {}
