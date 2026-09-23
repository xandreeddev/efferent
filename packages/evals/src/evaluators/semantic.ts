import { Effect, Match } from "effect"
import { AssessmentError } from "../assessment.entity.js"
import type { Metric } from "../assessment.entity.js"
import type { Evaluator } from "../assessment.usecase.js"
import type { SemanticQuestions } from "../semantic.entity.js"
import { validateSemanticInput, validateSemanticAnswers } from "../semantic.entity.functions.js"
import { SemanticJudge } from "../ports/semantic-judge.port.js"

export const semanticEvaluator = <I>(options: {
  readonly id: string
  readonly version: string
  readonly questions: SemanticQuestions
  readonly state: (input: I) => string
}): Evaluator<I, SemanticJudge> => ({
  id: options.id, version: options.version, metrics: Object.keys(options.questions),
  run: (input) => Effect.gen(function* () {
    const request = yield* validateSemanticInput({ state: options.state(input), questions: options.questions })
    if (Object.values(request.questions).some((question) => question.type === "choice" && Object.keys(question.criteria).some((key) => !["A", "B", "tie"].includes(key))))
      return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Preference metrics require A/B/tie choices; use SemanticJudge directly for categorical decisions" }))
    const judge = yield* SemanticJudge
    const result = yield* judge.evaluate(request)
    const answers = yield* validateSemanticAnswers(request, result.answers)
    return {
      metrics: Object.entries(answers).map(([name, answer]): Metric => Match.value(answer).pipe(
        Match.when({ type: "boolean" }, (value): Metric => ({ kind: "probability", name, value: value.probability })),
        Match.when({ type: "score" }, (value): Metric => {
          const question = request.questions[name]!
          return { kind: "score", name, value: value.score, min: 0, max: question.type === "score" ? question.criteria.length - 1 : 1 }
        }),
        Match.when({ type: "choice" }, (value): Metric => ({ kind: "preference", name, value: value.choice === "A" || value.choice === "B" ? value.choice : "tie" })),
        Match.exhaustive,
      )),
      reason: "Structured rubric assessment", usage: result.usage,
      metadata: { ...result.metadata, backend: judge.id, answers },
    }
  }),
})
