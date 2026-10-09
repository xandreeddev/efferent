import { Effect, Match, Schema } from "effect"
import { AssessmentError } from "./assessment.entity.js"
import { SemanticAnswers, SemanticInput } from "./semantic.entity.js"
import type { SemanticQuestions } from "./semantic.entity.js"

const invalid = (error: unknown) => new AssessmentError({ code: "invalid", message: String(error) })
export const validateSemanticInput = (input: SemanticInput) => Schema.decodeEffect(Schema.toType(SemanticInput))(input).pipe(Effect.mapError(invalid))

export const validateSemanticAnswers = (input: SemanticInput, value: unknown) => Effect.gen(function* () {
  yield* validateSemanticInput(input)
  const answers = yield* Schema.decodeUnknownEffect(SemanticAnswers)(value).pipe(Effect.mapError(invalid))
  const ids = Object.keys(input.questions)
  if (Object.keys(answers).length !== ids.length || ids.some((id) => {
    const question = input.questions[id]!
    const answer = answers[id]
    if (!Object.hasOwn(answers, id) || !answer || answer.type !== question.type) return true
    if (answer.type === "score" && question.type === "score") return answer.score > question.criteria.length - 1
    if (answer.type === "choice" && question.type === "choice") return !Object.hasOwn(question.criteria, answer.choice)
    return false
  })) return yield* Effect.fail(invalid("Judge answers do not match question IDs, types or scales"))
  return answers
})

/** Reject excess fields before decoding, while exposing a finite object schema to providers. */
const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const struct = Schema.Struct(fields)
  const declared = Object.keys(fields)
  return Schema.Unknown.check(Schema.makeFilter(
    (value) => Schema.is(struct)(value) && typeof value === "object" && value !== null && Object.keys(value).every((key) => declared.includes(key)),
    { toJsonSchema: () => Schema.toJsonSchemaDocument(struct, { onExcessProperty: "error" }).schema },
  )).pipe(Schema.decodeTo(struct))
}

/** A provider-facing schema with exactly the rubric's question IDs and offered choices. */
export const semanticResponseSchema = (questions: SemanticQuestions) => Schema.Struct({
  answers: exactStruct(Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
    Match.value(question).pipe(
      Match.when({ type: "boolean" }, () => Schema.Struct({ type: Schema.Literal("boolean"), probability: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))) })),
      Match.when({ type: "score" }, (value) => Schema.Struct({ type: Schema.Literal("score"), score: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: value.criteria.length - 1 }))) })),
      Match.when({ type: "choice" }, (value) => Schema.Struct({ type: Schema.Literal("choice"), choice: Schema.Literals(Object.keys(value.criteria)) })),
      Match.exhaustive,
    ),
  ]))),
})
