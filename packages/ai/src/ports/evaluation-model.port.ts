import { Context } from "effect"
import type { Effect } from "effect"
import type { DecisionAnswers, EvaluationError, RenderedDecision } from "../decision.entity.js"

/**
 * A model that answers decision questions about a state: a probability per
 * boolean question and one offered choice per choice question, for every
 * question asked and nothing else.
 */
export class EvaluationModel extends Context.Tag("efferent/ai/EvaluationModel")<EvaluationModel, {
  readonly model: string
  readonly evaluate: (rendered: RenderedDecision) => Effect.Effect<DecisionAnswers, EvaluationError>
}>() {}
