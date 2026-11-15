import { Cause, Effect, Match, Option, Predicate, Result, Stream } from "effect"
import type { ExecutionPlan } from "effect"
import { AiError } from "effect/ai"
import { CurrentTurn } from "./current-turn.port.js"
import { ModelAnswerFailed } from "./model-answer.entity.js"
import { AnswerCut, attemptEvent } from "./planned.entity.js"
import type { AttemptData } from "./planned.entity.js"

/**
 * Whether a model call that failed with `error` is worth making again: an `AiError` whose reason says so (a rate
 * limit, a provider's own error, a lost connection). A plan's step takes it as its `while`. An `AnswerCut` is never
 * worth it, and neither is any other failure.
 *
 * @public
 */
export const retryable = (error: unknown): boolean => AiError.isAiError(error) && error.isRetryable

/** A part that hands on something of the answer: a piece of its text, or a call it asks for. */
const isContent = (part: { readonly type: string }): boolean => part.type === "text-delta" || part.type === "tool-call"

/** A failure's own words, for the attempt's event. */
const wordsOf = (error: unknown): string =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? error.message : Predicate.isString(error) ? error : "the attempt failed"

/** What ended an attempt, in words: its failure's own, that it was stopped, or that it broke. */
const causeWords = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: wordsOf,
    onNone: () => (Cause.hasInterruptsOnly(cause) ? "stopped" : Result.match(Cause.findDefect(cause), { onFailure: () => "the attempt failed", onSuccess: (defect) => (defect instanceof Cut ? defect.answer.message : wordsOf(defect)) })),
  })

/** What an attempt event says, as `plugin.model.attempt`'s data. */
const attemptOf = (event: ExecutionPlan.Event<unknown>): AttemptData => Match.valueTags(event, {
  AttemptStart: ({ attempt, stepIndex }): AttemptData => ({ outcome: "started", attempt, step: stepIndex }),
  AttemptSuccess: ({ attempt, stepIndex }): AttemptData => ({ outcome: "succeeded", attempt, step: stepIndex }),
  AttemptFailure: ({ attempt, stepIndex, cause }): AttemptData => ({ outcome: "failed", attempt, step: stepIndex, reason: causeWords(cause) }),
})

/**
 * Say one attempt about the turn the call is for, when it has one (`CurrentTurn`, which `modelAnswer` provides; a
 * loop that calls the model by hand has none, and nothing is said). A publish that fails is logged as a warning,
 * and never fails the call.
 */
const said = (event: ExecutionPlan.Event<unknown>): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(CurrentTurn), (turn) => Option.match(turn, {
    onNone: () => Effect.void,
    onSome: (open) => open.publish(attemptEvent, attemptOf(event)).pipe(Effect.ignoreCause({ log: "Warn", message: "a model attempt could not be said" })),
  }))

/**
 * How an `AnswerCut` crosses the plan: as a defect, which the plan neither retries nor falls back from, wrapped in a
 * class of this module's own, so `planned` takes back only the cuts it made.
 */
class Cut {
  constructor(readonly answer: AnswerCut) {}
}

/**
 * One attempt of a model's answer as a plan may run it: the parts before the first one that hands on content (a
 * stream's start, the model's name) are held back until it comes, so an attempt that fails before any content has
 * handed on nothing, and the plan retries it or falls back; one that ends with no content hands its held parts on
 * as it ends. An error the model reports in its stream before any content fails the attempt with
 * `ModelAnswerFailed`, as `modelAnswer` would fail the call, so the plan can act on it (Effect's providers report a
 * provider's overload that way). Once content went on, a failure is final: it dies, which a plan does not retry or
 * fall back from, and `planned` turns it back into an `AnswerCut`, an error part then as any other failure.
 * An interruption and a defect pass as they are.
 */
const onePass = <A extends { readonly type: string }, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | ModelAnswerFailed, R> =>
  Stream.suspend(() => {
    const held: Array<A> = []
    let open = false
    return stream.pipe(
      Stream.flatMap((part): Stream.Stream<A, ModelAnswerFailed> => {
        if (part.type === "error") {
          const error = Predicate.hasProperty(part, "error") ? part.error : part
          return open
            ? Stream.die(new Cut(new AnswerCut({ message: wordsOf(error), cause: error })))
            : Stream.fail(new ModelAnswerFailed({ message: wordsOf(error), cause: error }))
        }
        if (open) return Stream.succeed(part)
        if (!isContent(part)) {
          held.push(part)
          return Stream.empty
        }
        open = true
        return Stream.fromIterable([...held.splice(0), part])
      }),
      Stream.concat(Stream.suspend(() => Stream.fromIterable(held.splice(0)))),
      Stream.catch((error) => (open ? Stream.die(new Cut(new AnswerCut({ message: wordsOf(error), cause: error }))) : Stream.fail(error))),
    )
  })

/**
 * A model's answer made under a plan of Effect's (`ExecutionPlan`): each step provides a model, and says how often
 * to try it and when (`attempts`, `schedule`, `while`: `retryable` for the failures worth another try); a step that
 * gives up hands the call to the next. A step's `while` reads what an attempt fails with: the model's own error, or
 * `ModelAnswerFailed` when the model reported an error in its stream before any content (`retryable` reads anything).
 * On top of the plan it holds one rule of the answer's: **once a word of it was handed on, it is never made again**,
 * by the same model or another, and a failure from then on is an `AnswerCut`.
 * Each attempt is said about its turn (`plugin.model.attempt`, live). Apply it to the stream the loop asks the model
 * for, before `modelAnswer` reads it; the model it needs is then the plan's.
 *
 * @public
 */
export const planned = <Input, R2, Provides, PolicyE>(plan: ExecutionPlan.ExecutionPlan<{ provides: Provides; input: Input | ModelAnswerFailed; error: PolicyE; requirements: R2 }>) =>
  <A extends { readonly type: string }, E extends Input, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | ModelAnswerFailed | PolicyE | AnswerCut, R2 | Exclude<R, Provides>> =>
    onePass(stream).pipe(
      Stream.withExecutionPlan(plan, { onEvent: said }),
      Stream.catchCause((cause): Stream.Stream<never, E | ModelAnswerFailed | PolicyE | AnswerCut> => Result.match(Cause.findDefect(cause), {
        onFailure: () => Stream.failCause(cause),
        onSuccess: (defect) => (defect instanceof Cut ? Stream.fail(defect.answer) : Stream.failCause(cause)),
      })),
    )
