import { Effect, Match, Schema } from "effect"
import { AssessmentError } from "./assessment.entity.js"
import { SemanticAnswers, SemanticInput } from "./semantic.entity.js"
import type { SemanticQuestions } from "./semantic.entity.js"

const invalid = (message: string, cause?: unknown) => new AssessmentError({ code: "invalid", message, cause })
/** @public */
export const validateSemanticInput = (input: SemanticInput) => Schema.decodeEffect(Schema.toType(SemanticInput))(input).pipe(
  Effect.mapError((error) => invalid(`Semantic input does not decode: ${error.message}`, error)),
)

/** @public */
export const validateSemanticAnswers = Effect.fnUntraced(function* (input: SemanticInput, value: unknown) {
  yield* validateSemanticInput(input)
  const answers = yield* Schema.decodeUnknownEffect(SemanticAnswers)(value).pipe(Effect.mapError((error) => invalid(`Judge answers do not decode: ${error.message}`, error)))
  const ids = Object.keys(input.questions)
  if (Object.keys(answers).length !== ids.length || ids.some((id) => {
    const question = input.questions[id]!
    const answer = answers[id]
    if (!Object.hasOwn(answers, id) || !answer || answer.type !== question.type) return true
    // The answer is of the question's type: a score must be on its scale, a choice one it offers.
    return Match.value(question).pipe(Match.discriminatorsExhaustive("type")({
      boolean: () => false,
      score: (scored) => answer.type === "score" && answer.score > scored.criteria.length - 1,
      choice: (chosen) => answer.type === "choice" && !Object.hasOwn(chosen.criteria, answer.choice),
    }))
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

/**
 * A provider-facing schema with exactly the rubric's question IDs and offered choices.
 *
 * @public
 */
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
