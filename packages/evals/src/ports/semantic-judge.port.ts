import { Context } from "effect"
import type { Effect } from "effect"
import type { AssessmentError } from "../assessment.entity.js"
import type { SemanticInput, SemanticResult } from "../semantic.entity.js"

/** Backend selection is explicit; fallback belongs to a separately identified host adapter. */
export class SemanticJudge extends Context.Tag("efferent/evals/SemanticJudge")<SemanticJudge, {
  readonly id: string
  readonly evaluate: (input: SemanticInput) => Effect.Effect<SemanticResult, AssessmentError>
}>() {}
