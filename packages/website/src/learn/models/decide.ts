// A decision model (Jev, through the AI Gateway's `/v1/decisions`): it reads one input and answers typed questions with
// probabilities. A question is a predicate (yes or no, as a probability), a choice among the values it lists, or a
// score on the levels it lists. Each answer's type follows from its question's, so the code that reads an answer
// cannot ask a choice for a value it did not list.
//
// `decide` is the one function a caller uses; a `Decider` is where its answers come from: the gateway with the
// learner's key (`gatewayDecider`), or a scripted one for tests and pages that make no request (`scriptedDecider`).
import { Effect, Option, Predicate, Schema } from "effect"
import { AiError } from "effect/ai"
import { GATEWAY_URL } from "./gateway-wire.ts"
import type { Fetch } from "./gateway.ts"
import { failureOf } from "./gateway.ts"

/** The decision model the page uses: Jev, TypeSafe AI's, through the gateway. */
export const DEFAULT_DECISION_MODEL = "typesafe-ai/jev"

export interface Predicate<N extends string = string> { readonly type: "predicate"; readonly name: N; readonly instructions: string }
export interface Choice<N extends string = string, V extends string = string> {
  readonly type: "choice"
  readonly name: N
  readonly instructions: string
  readonly choices: ReadonlyArray<{ readonly value: V; readonly description?: string }>
}
export interface Score<N extends string = string, L extends string = string> {
  readonly type: "score"
  readonly name: N
  readonly instructions: string
  readonly levels: ReadonlyArray<{ readonly label: L; readonly description?: string }>
}
export type Question = Predicate | Choice | Score

/** The answer to one question, typed by it. */
export type AnswerTo<Q extends Question> =
  Q extends Predicate ? { readonly probability: number }
    : Q extends Choice<string, infer V> ? { readonly choice: V; readonly confidence: number; readonly probabilities: ReadonlyArray<{ readonly value: V; readonly probability: number }> }
      : Q extends Score<string, infer L> ? { readonly score: number; readonly confidence: number; readonly probabilities: ReadonlyArray<{ readonly value: number; readonly label: L; readonly probability: number }> }
        : never

/** The answers to a list of questions, by each question's name. */
export type Answers<Qs extends ReadonlyArray<Question>> = { readonly [Q in Qs[number] as Q["name"]]: AnswerTo<Q> }

/** Where answers come from: the questions as the wire sends them, and the answers as it gives them, by name. */
export interface Decider {
  readonly answer: (input: string, questions: ReadonlyArray<Question>) => Effect.Effect<ReadonlyMap<string, unknown>, AiError.AiError>
}

const Probability = Schema.Number
const PredicateAnswer = Schema.Struct({ probability: Probability })
const ChoiceAnswer = Schema.Struct({ choice: Schema.String, confidence: Probability, probabilities: Schema.Array(Schema.Struct({ value: Schema.String, probability: Probability })) })
const ScoreAnswer = Schema.Struct({ score: Schema.Number, confidence: Probability, probabilities: Schema.Array(Schema.Struct({ value: Schema.Number, label: Schema.String, probability: Probability })) })

const refused = (name: string) => AiError.make({ module: "decide", method: "decide", reason: new AiError.InvalidOutputError({ description: `The decision model gave no answer to "${name}": it refused it, or answered in a shape the question does not have.` }) })

/**
 * Ask `questions` of `input`. The answers come back by name, each typed by its question; a choice's answer is checked
 * to be one of the values the question listed, and a score's labels to be its levels.
 */
export const decide = <const Qs extends ReadonlyArray<Question>>(decider: Decider, input: string, questions: Qs): Effect.Effect<Answers<Qs>, AiError.AiError> =>
  decider.answer(input, questions).pipe(Effect.flatMap((byName) => {
    const out: Record<string, unknown> = {}
    for (const question of questions) {
      const raw = byName.get(question.name)
      const decoded: Option.Option<unknown> =
        question.type === "predicate" ? Schema.decodeUnknownOption(PredicateAnswer)(raw)
          : question.type === "choice" ? Option.filter(Schema.decodeUnknownOption(ChoiceAnswer)(raw), (one) => question.choices.some((choice) => choice.value === one.choice))
            : Option.filter(Schema.decodeUnknownOption(ScoreAnswer)(raw), (one) => one.probabilities.every((level) => question.levels.some((known) => known.label === level.label)))
      if (Option.isNone(decoded)) return Effect.fail(refused(question.name))
      out[question.name] = decoded.value
    }
    // Each name was given the answer its question's type decodes to: the record is the mapped type, built in a loop.
    return Effect.succeed(out as Answers<Qs>)
  }))

const Response = Schema.Struct({ answers: Schema.Array(Schema.Json) })

/** The gateway's decision model, with the key `keyOf` gives at each request (none: a failure in words, nothing sent). */
export const gatewayDecider = (keyOf: () => Option.Option<string>, model: string = DEFAULT_DECISION_MODEL, fetchFn: Fetch = (url, init) => fetch(url, init)): Decider => ({
  answer: (input, questions) => Option.match(keyOf(), {
    onNone: () => Effect.fail(AiError.make({ module: "decide", method: "decide", reason: new AiError.AuthenticationError({ kind: "Unknown", description: "No AI Gateway key is kept: enter one in the gateway's card in the model list." }) })),
    onSome: (key) => Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchFn(`${GATEWAY_URL}/decisions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, input, questions }),
          signal,
        })
        const text = await response.text()
        if (!response.ok) throw failureOf(response.status, text)
        return text
      },
      catch: (error) => (AiError.isAiError(error) ? error : AiError.make({ module: "decide", method: "decide", reason: new AiError.InternalProviderError({ description: `The gateway could not be reached, or refused the request (${error instanceof Error ? error.message : String(error)}). It answers a wrong key, a key past its spending limit, an unknown model and a busy provider without the headers a page needs to read why: check your connection, then the key and its limit in your Vercel dashboard, then the model.` }) })),
    }).pipe(Effect.flatMap((text) => Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Response))(text), {
      onNone: () => Effect.fail(AiError.make({ module: "decide", method: "decide", reason: new AiError.InvalidOutputError({ description: "The decision model's answer was not in the shape the gateway documents." }) })),
      // Each answer by its question's name; one with no name, or a refusal, is passed over, and `decide` says so.
      onSome: ({ answers }) => Effect.succeed(new Map(answers.flatMap((answer) =>
        Predicate.hasProperty(answer, "name") && Predicate.isString(answer.name) && !(Predicate.hasProperty(answer, "type") && answer.type === "refusal") ? [[answer.name, answer] as const] : []))),
    }))),
  }),
})

/**
 * A decider that makes no request: each question is answered by `rule`, given the input and the question; a question
 * the rule gives nothing for is refused, as a model may refuse. For tests, and for a page that runs on Echo.
 */
export const scriptedDecider = (rule: (input: string, question: Question) => Option.Option<unknown>): Decider => ({
  answer: (input, questions) => Effect.succeed(new Map(questions.flatMap((question) => Option.match(rule(input, question), {
    onNone: () => [],
    onSome: (answer) => [[question.name, answer] as const],
  })))),
})
