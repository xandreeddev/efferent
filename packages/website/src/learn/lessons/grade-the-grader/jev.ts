// The real Jev behind the package's judge: a transport for `SemanticJevLive`, over the page's
// `decide` (models/decide.ts) and the gateway's decision model. The package asks its questions in
// its own shape (`SemanticInput`: the text, and each question by name with its kind and words);
// `decide` asks them as the gateway takes them (a list of predicates, choices and scores, each with
// its name). The mapping is yes-or-no questions alone: a boolean question is a predicate, and a
// predicate's probability comes back as a boolean answer. No score or choice reply has been seen
// from the gateway, so a score or a choice question is refused, in the page's words, and nothing
// is sent.
import { Effect, Predicate, Result } from "effect"
import { AiError } from "effect/ai"
import type { SemanticAnswers, SemanticInput, SemanticJevOptions } from "@xandreed/evals"
import { textOf } from "../../evaluate.ts"
import { decide } from "../../models/decide.ts"
import type { Answers, Decider, Predicate as YesOrNo } from "../../models/decide.ts"

/** The words a failure of the gateway's with no words of its own is said in, by its kind. */
const FAILED_WITHOUT_WORDS: Readonly<Record<string, string>> = {
  RateLimitError: "the gateway is busy, too many requests at once: check the graders again in a moment.",
  QuotaExhaustedError: "the gateway key has reached its spending limit.",
}

/**
 * Why a request to Jev failed, in words: the failure's own description where it has one (a refused key, a provider
 * that failed, an answer that was not one), else words for its kind. The name of the code that failed is no part of
 * them: a learner reads them in a cell of the table.
 */
export const failureWords = (failure: unknown): string => {
  if (!AiError.isAiError(failure)) return textOf(failure)
  const reason: unknown = failure.reason
  const description = Predicate.hasProperty(reason, "description") && Predicate.isString(reason.description) ? reason.description : ""
  const kind = Predicate.hasProperty(reason, "_tag") && Predicate.isString(reason._tag) ? reason._tag : ""
  return description.length > 0 ? description : FAILED_WITHOUT_WORDS[kind] ?? textOf(failure)
}

/** Why a question that is not yes or no is refused. */
export const notYesOrNo = (name: string, type: string): string =>
  `the page asks Jev yes-or-no questions alone, and "${name}" is a ${type} question: no score or choice reply has been seen from the gateway.`

/** One of the package's questions as `decide`'s predicate, or why it is none. */
const predicateOf = ([name, question]: readonly [string, SemanticInput["questions"][string]]): Result.Result<YesOrNo, string> =>
  question.type === "boolean" ? Result.succeed({ type: "predicate", name, instructions: question.instructions }) : Result.fail(notYesOrNo(name, question.type))

/** The package's questions as `decide`'s, in their order: each a predicate by its name, or the first that is none, refused. */
export const predicatesOf = (input: SemanticInput): Result.Result<ReadonlyArray<YesOrNo>, string> =>
  Result.all(Object.entries(input.questions).map(predicateOf))

/** `decide`'s answers as the package's: each predicate's probability, as a boolean answer under the same name. */
export const answersOf = (answers: Answers<ReadonlyArray<YesOrNo>>): SemanticAnswers =>
  Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, { type: "boolean", probability: answer.probability }]))

/**
 * The transport: one request to the decider for each `evaluate`, stopped by the package's signal (its deadline, or a
 * run that was stopped). A question refused, or a request that failed, rejects with its words, which the package's
 * judge says after "Jev request failed: ".
 */
export const jevTransport = (decider: Decider): SemanticJevOptions["evaluate"] => (input, signal) =>
  Result.match(predicatesOf(input), {
    onFailure: (words) => Promise.reject(new Error(words)),
    onSuccess: (predicates) => Effect.runPromise(decide(decider, input.state, predicates).pipe(
      Effect.map((answers) => ({ answers: answersOf(answers) })),
      Effect.mapError((failure) => new Error(failureWords(failure))),
    ), { signal }),
  })
