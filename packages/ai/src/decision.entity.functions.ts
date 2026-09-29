import { Effect, Match, Option, Schema } from "effect"
import { PromptId } from "@xandreed/core"
import type { PromptProvenance } from "@xandreed/core"
import { EvaluationError, WireAnswers } from "./decision.entity.js"
import type {
  AnswersOf,
  DecisionAnswer,
  DecisionAnswers,
  DecisionPrompt,
  DecisionQuestion,
  DecisionQuestions,
  QuestionOverrides,
  RenderedDecision,
  WireAnswer,
} from "./decision.entity.js"
import { decisionHash } from "./hash.adapter.js"
import { EvaluationModel } from "./ports/evaluation-model.port.js"
import { PromptError } from "./prompt.entity.js"
import type { ModelTarget, SelectedVariant, Variants } from "./prompt.entity.js"
import { currentTarget, selectVariant, withProvenance } from "./prompt.entity.functions.js"

const invalid = (message: string) => new EvaluationError({ code: "invalid", message })
const reworded = (message: string) => new PromptError({ code: "variant.invalid", message })

/** Define a decision prompt; its variants reword questions by id. */
export const defineDecisionPrompt = <I, Q extends DecisionQuestions>(definition: {
  readonly id: string
  readonly version: string
  readonly family: string
  readonly state: (input: I) => string | Readonly<Record<string, unknown>>
  readonly questions: (input: I) => Q
  readonly variants?: Variants<QuestionOverrides>
}): DecisionPrompt<I, Q> => ({
  _tag: "DecisionPrompt",
  id: PromptId.make(definition.id),
  version: definition.version,
  family: definition.family,
  state: definition.state,
  questions: definition.questions,
  variants: Option.fromNullishOr(definition.variants),
})

/** A variant's wording applied: instructions, and descriptions of choices already offered. It never adds a question or a choice. */
const reword = <Q extends DecisionQuestions>(questions: Q, overrides: QuestionOverrides): Effect.Effect<Q, PromptError> => Effect.gen(function* () {
  const unknown = Object.keys(overrides).filter((id) => !Object.hasOwn(questions, id))
  if (unknown.length > 0) return yield* Effect.fail(reworded(`The variant rewords questions that are not asked: ${unknown.join(", ")}`))
  const entries = yield* Effect.forEach(Object.entries(questions), ([id, question]) => {
    const override = Object.hasOwn(overrides, id) ? overrides[id] : undefined
    if (override === undefined) return Effect.succeed([id, question] as const)
    const instructions = override.instructions ?? question.instructions
    return Match.value(question).pipe(
      Match.when({ type: "boolean" }, (boolean): Effect.Effect<readonly [string, DecisionQuestion], PromptError> => override.criteria === undefined
        ? Effect.succeed([id, { ...boolean, instructions }] as const)
        : Effect.fail(reworded(`${id} is a boolean question; it offers no choices to describe`))),
      Match.when({ type: "choice" }, (choice): Effect.Effect<readonly [string, DecisionQuestion], PromptError> => {
        const described = override.criteria ?? {}
        const unoffered = Object.keys(described).filter((key) => !Object.hasOwn(choice.criteria, key))
        return unoffered.length > 0
          ? Effect.fail(reworded(`The variant describes choices ${id} does not offer: ${unoffered.join(", ")}`))
          : Effect.succeed([id, { ...choice, instructions, criteria: { ...choice.criteria, ...described } }] as const)
      }),
      Match.exhaustive,
    )
  })
  return Object.fromEntries(entries) as Q
})

const stateText = (state: string | Readonly<Record<string, unknown>>): string => typeof state === "string" ? state : JSON.stringify(state)

const rendered = <Q extends DecisionQuestions>(
  identity: { readonly id: typeof PromptId.Type; readonly version: string; readonly family: string },
  state: string,
  questions: Q,
  variant: string,
  modelOverride: Option.Option<string>,
): Effect.Effect<RenderedDecision<Q>, PromptError> => decisionHash(state, questions).pipe(Effect.map((hash): RenderedDecision<Q> => {
  const provenance: PromptProvenance = { id: identity.id, version: identity.version, variant, modelOverride, hash }
  return { state, questions, family: identity.family, provenance }
}))

/**
 * Render a decision for `target` (default: `currentTarget`): the state as
 * text, the questions as its variant words them, and the provenance, whose
 * hash is SHA-256 of `JSON.stringify({ state, questions })`.
 */
export const renderDecision = <I, Q extends DecisionQuestions>(prompt: DecisionPrompt<I, Q>, input: I, target?: ModelTarget): Effect.Effect<RenderedDecision<Q>, PromptError> =>
  Effect.gen(function* () {
    const resolved = target ?? (yield* currentTarget)
    const selected = yield* Option.match(prompt.variants, {
      onNone: () => Effect.succeed<SelectedVariant<QuestionOverrides>>({ fragment: {}, override: Option.none() }),
      onSome: (variants) => selectVariant(variants, resolved),
    })
    const questions = yield* reword(prompt.questions(input), selected.fragment)
    return yield* rendered(prompt, stateText(prompt.state(input)), questions, resolved.variant, selected.override)
  })

/** A decision rendered without a prompt definition, for questions a host builds itself. */
export const rawDecision = <Q extends DecisionQuestions>(
  identity: { readonly id: string; readonly version: string; readonly family: string; readonly variant?: string },
  state: string | Readonly<Record<string, unknown>>,
  questions: Q,
): Effect.Effect<RenderedDecision<Q>, PromptError> =>
  rendered({ ...identity, id: PromptId.make(identity.id) }, stateText(state), questions, identity.variant ?? "baseline", Option.none())

const answerOf = (id: string, question: DecisionQuestion, answer: WireAnswer): Effect.Effect<readonly [string, DecisionAnswer], EvaluationError> =>
  Match.value(question).pipe(
    Match.when({ type: "boolean" }, (): Effect.Effect<readonly [string, DecisionAnswer], EvaluationError> => answer.type === "boolean"
      ? Effect.succeed([id, { _tag: "boolean", probability: answer.probability }] as const)
      : Effect.fail(invalid(`${id} asks for a probability, not a choice`))),
    Match.when({ type: "choice" }, (choice): Effect.Effect<readonly [string, DecisionAnswer], EvaluationError> => {
      if (answer.type !== "choice") return Effect.fail(invalid(`${id} asks for a choice, not a probability`))
      if (!Object.hasOwn(choice.criteria, answer.choice)) return Effect.fail(invalid(`${id}: ${answer.choice} was not offered (${Object.keys(choice.criteria).join(", ")})`))
      return Effect.succeed([id, { _tag: "choice", choice: answer.choice, confidence: Option.fromNullishOr(answer.confidence) }] as const)
    }),
    Match.exhaustive,
  )

/**
 * Check a transport's answers against the questions asked: every question
 * answered, nothing else, a probability for each boolean question and an
 * offered choice for each choice question.
 */
export const validateAnswers = <Q extends DecisionQuestions>(questions: Q, raw: unknown): Effect.Effect<AnswersOf<Q>, EvaluationError> => Effect.gen(function* () {
  const answers = yield* Schema.decodeUnknownEffect(WireAnswers)(raw, { reportInput: true }).pipe(Effect.mapError((error) => invalid(error.message)))
  const extra = Object.keys(answers).filter((id) => !Object.hasOwn(questions, id))
  if (extra.length > 0) return yield* Effect.fail(invalid(`Answers to questions not asked: ${extra.join(", ")}`))
  const unanswered = Object.keys(questions).filter((id) => !Object.hasOwn(answers, id))
  if (unanswered.length > 0) return yield* Effect.fail(invalid(`Questions not answered: ${unanswered.join(", ")}`))
  const checked = yield* Effect.forEach(Object.entries(questions), ([id, question]) => answerOf(id, question, answers[id]!))
  return Object.fromEntries(checked) as AnswersOf<Q>
})

/** The wire form of domain answers (what `validateAnswers` reads). */
export const wireOf = (answers: DecisionAnswers): WireAnswers => Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, Match.value(answer).pipe(
  Match.tag("boolean", (boolean): WireAnswer => ({ type: "boolean", probability: boolean.probability })),
  Match.tag("choice", (choice): WireAnswer => Option.match(choice.confidence, {
    onNone: () => ({ type: "choice", choice: choice.choice }),
    onSome: (confidence) => ({ type: "choice", choice: choice.choice, confidence }),
  })),
  Match.exhaustive,
)]))

/** Render the decision and ask the EvaluationModel, under the decision's provenance; its answers are checked against the questions. */
export const evaluateDecision = <I, Q extends DecisionQuestions>(
  prompt: DecisionPrompt<I, Q>,
  input: I,
  target?: ModelTarget,
): Effect.Effect<AnswersOf<Q>, PromptError | EvaluationError, EvaluationModel> => Effect.gen(function* () {
  const decision = yield* renderDecision(prompt, input, target)
  const model = yield* EvaluationModel
  const answers = yield* model.evaluate(decision).pipe(withProvenance(decision.provenance))
  return yield* validateAnswers(decision.questions, wireOf(answers))
})
