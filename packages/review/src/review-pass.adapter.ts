import { Array as Arr, Effect, Layer, Match, Option, Order, Predicate, Result, Schema, Stream } from "effect"
import { AiError, LanguageModel, Prompt } from "effect/ai"
import { JournalStorage, kernel, ModelSpend, Sessions, userMessage } from "@xandreed/core"
import type { SessionId, SpendHold } from "@xandreed/core"
import { callTool, clipTo, flatMemory, Memory, modelAnswer, recoverTurns, retryable, sessions } from "@xandreed/sdk"
import { directoryJournal, isSpendRefusal } from "@xandreed/sdk/node"
import type { Checkout } from "./checkout.port.js"
import { Findings } from "./findings.port.js"
import { PassJournalFailed, SUMMARY_KEPT } from "./review-pass.entity.js"
import type { CallUsage, PassEnded, PassResult } from "./review-pass.entity.js"
import { ReviewPasses } from "./review-pass.port.js"
import type { PassInput } from "./review-pass.port.js"
import { stepCapNote } from "./review-prompt.entity.functions.js"
import { reviewToolHandlers, reviewTools } from "./review-tools.adapter.js"
import { READ_DIFF, READ_LINES, REPORT_FINDING, VERDICT } from "./review-tools.entity.js"
import { stageSpend } from "./stage-spend.adapter.js"

/** The owner a pass's session is created under in its journal. */
export const PASS_OWNER = "efferent-review"

/** The path a `readLines` or `readDiff` call names, when its parameters hold one. */
const OpenedPath = Schema.Struct({ path: Schema.String })

/** What a failure says, in its own words when it has them. */
const wordsOf = (error: unknown, otherwise: string): string =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message.length > 0 ? error.message : otherwise

/** A failure of the pass's journal (opening, recovering, reading or writing it) as the pass's own failure. */
const kept = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PassJournalFailed, R> =>
  Effect.mapError(effect, (cause) => new PassJournalFailed({ message: wordsOf(cause, "the journal failed"), cause }))

/** Whether a failed answer is the model's (a refused, cut or failed call), not the journal's. */
const isModels = (error: unknown): boolean => AiError.isAiError(error) || Predicate.isTagged(error, "ModelAnswerFailed")

/** Whether a failed call is worth making again: the model's failure whose reason says so (`retryable`), also as a stream's error part's cause. */
const worthAnotherTry = (error: unknown): boolean =>
  retryable(error) || (Predicate.isTagged(error, "ModelAnswerFailed") && Predicate.hasProperty(error, "cause") && retryable(error.cause))

/**
 * What a pass runs on, each a part a host may swap: the model (a layer charging the `ModelSpend` it is given: each pass
 * builds it over a ledger of its own inside its stage's), the memory that builds each step's context (`flatMemory` by
 * default), the tools' handlers over what the pass reviews (`reviewToolHandlers` by default), and the journal kept at
 * an input's `journalAt` (a `directoryJournal` in that folder by default), whose failure to open is a
 * `PassJournalFailed`.
 */
export interface KernelPassesOptions {
  readonly model: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>
  readonly memory?: Layer.Layer<Memory>
  readonly tools?: typeof reviewToolHandlers
  readonly journal?: (at: string) => Layer.Layer<JournalStorage, PassJournalFailed>
}

/** The stock journal: a `directoryJournal` in the folder `at`, a refusal to open it a `PassJournalFailed`. */
const folderJournal = (at: string): Layer.Layer<JournalStorage, PassJournalFailed> =>
  directoryJournal({ directory: at }).pipe(
    Layer.catchTag("JournalOpenFailed", (cause) => Layer.effect(JournalStorage, Effect.fail(new PassJournalFailed({ message: wordsOf(cause, "the journal could not be opened"), cause })))),
  )

/**
 * One pass or check over the kernel: a session in the journal at `journalAt` (its turns recovered first), the memory,
 * the review's tools, the model over a ledger of the pass's own inside its stage's (`stageSpend`, so each call's cost is
 * what that ledger settled while it ran, whatever runs beside it), and the host's loop with `modelAnswer` and
 * `callTool`. Each step sends the prompt's prefix, then what the memory gives (the tail message, the calls and their
 * results). It ends when the model answers without a call; for a check, once its verdict is recorded; when the ledger
 * refuses a call, when a call fails, when an answer is cut at the output cap (its finish says `length`; the calls it
 * asked for run first, so a finding it reported is kept), or when the journal fails: each with the findings recorded
 * so far. From its start it holds back `options.reserve` from its stage for its closing call; at its step cap, or
 * when the ledger refuses a later call while that reserve is held, it releases the reserve, stores the host's note
 * (`stepCapNote`) and asks once more, offering the same tools so the provider's cache holds, and runs only the calls
 * that report (`reportFinding` in a pass, `verdict` in a check); a closing call that fails is said in `StepCap`'s
 * `why`. `onFirstAnswer` is given, once, whether its first call answered (`false` when it ended before one returned);
 * when it is given, the other passes wait on that call, so a failure of it worth another try (`retryable`: a rate
 * limit, a provider's error, a lost connection) is asked once more first.
 */
const runPass = Effect.fn("review.pass")(function* (input: PassInput, parts: Required<KernelPassesOptions>) {
  const own = yield* stageSpend(input.spend, Option.none())
  const settled = Effect.map(Effect.orDie(own.totals), (totals) => totals.settled)
  const findings = yield* Findings
  const stage = input.reviewed.stage
  const reports = Match.valueTags(stage, { Find: () => REPORT_FINDING, Verify: () => VERDICT })
  const judged = Match.valueTags(stage, {
    Find: () => Effect.succeed(false),
    Verify: ({ check }) => Effect.map(findings.verdictOf(input.reviewed.run, check), Option.isSome),
  })
  const calls: Array<CallUsage> = []
  const opened = new Set<string>()
  let made: Option.Option<SessionId> = Option.none()
  let signalled = false
  /** The hold kept back for the closing call, while it is held. */
  let reserved: Option.Option<SpendHold> = Option.none()
  const releaseReserve = Effect.suspend(() => Option.match(reserved, {
    onNone: () => Effect.void,
    onSome: (hold) => {
      reserved = Option.none()
      return input.spend.release(hold).pipe(Effect.tapError((error) => Effect.logWarning("a review pass's reserve could not be released", error)), Effect.ignore)
    },
  }))
  const signal = (answered: boolean) => Effect.suspend(() => {
    if (signalled || input.onFirstAnswer === undefined) return Effect.void
    signalled = true
    return input.onFirstAnswer(answered)
  })

  const loop = Effect.scoped(Effect.gen(function* () {
    yield* kept(recoverTurns)
    const memory = yield* Memory
    const toolkit = yield* reviewTools
    const conversations = yield* Sessions
    const id = yield* kept(conversations.create({ owner: PASS_OWNER }))
    made = Option.some(id)
    const session = yield* kept(conversations.open(id))
    yield* kept(session.append(userMessage(input.prompt.tail)))
    // What the closing call will need, held back from the stage now; a stage with no room for it goes on without.
    if (input.options.reserve > 0) reserved = yield* input.spend.keepBack(input.options.reserve)

    /** One model call: its answer and whether it was cut at the output cap, or how the pass ends when it failed. */
    const ask = (step: number) => Effect.gen(function* () {
      const context = yield* kept(memory.context(session))
      const prompt = Prompt.make([...input.prompt.prefix, ...context])
      let finish = ""
      const stream = LanguageModel.streamText({ prompt, toolkit: reviewTools, disableToolCallResolution: true, toolCallValidation: "deferred" }).pipe(
        Stream.tap((part) => Effect.sync(() => {
          if (part.type === "finish") finish = part.reason
        })),
      )
      /** What the pass's own ledger settled since `before`, rounded past the float noise of a difference. */
      const spentSince = (before: number) => Effect.map(settled, (now) => Math.max(0, Math.round((now - before) * 1e12) / 1e12))
      const before = yield* settled
      const tried = yield* Effect.result(modelAnswer(stream, session))
      // The call the other passes wait on is asked once more after a failure worth another try (a rate limit, a
      // provider's error, a lost connection): one blip would otherwise end the whole find stage. A failed answer
      // stores nothing, so the second try is the same request; the failed one is a call of its own in the record.
      const again = Result.isFailure(tried) && step === 1 && input.onFirstAnswer !== undefined && worthAnotherTry(tried.failure)
      if (again) {
        calls.push({ step, tokens: Option.none(), cost: yield* spentSince(before) })
        yield* Effect.logWarning("a review pass's first call failed and is asked once more", wordsOf(tried.failure, "the model call failed"))
      }
      const retriedAt = yield* settled
      const answered = again ? yield* Effect.result(modelAnswer(stream, session)) : tried
      const cost = yield* spentSince(again ? retriedAt : before)
      yield* signal(Result.isSuccess(answered))
      if (Result.isFailure(answered)) {
        calls.push({ step, tokens: Option.none(), cost })
        const error = answered.failure
        if (!isModels(error)) return yield* Effect.fail(new PassJournalFailed({ message: wordsOf(error, "the journal failed"), cause: error }))
        return Result.fail<PassEnded>(isSpendRefusal(error)
          ? { _tag: "SpendRefused", message: wordsOf(error, "the spend cap refused the call") }
          : { _tag: "ModelFailed", message: wordsOf(error, "the model call failed") })
      }
      const answer = answered.success
      calls.push({ step, tokens: Option.map(answer.usage, (usage) => ({ input: usage.inputTokens, cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens })), cost })
      return Result.succeed({ answer, cut: finish === "length" })
    })

    /**
     * The closing call, at the step cap or after a spend refusal: the reserve released, the host's note, then one more
     * call whose reporting calls alone run. Its words, or why it failed.
     */
    const closing = (step: number) => Effect.gen(function* () {
      yield* releaseReserve
      yield* kept(session.append(userMessage(stepCapNote(stage))))
      const last = yield* ask(step)
      if (Result.isFailure(last)) return { summary: "", why: "message" in last.failure ? last.failure.message : last.failure._tag }
      for (const call of last.success.answer.toolCalls.filter((call) => call.name === reports)) yield* kept(callTool(toolkit, call, session))
      return { summary: clipTo(last.success.answer.text.trim(), SUMMARY_KEPT), why: "" }
    })

    for (let step = 1; step <= input.options.maxSteps; step++) {
      const asked = yield* ask(step)
      if (Result.isFailure(asked)) {
        // A spend refusal after the first call: the closing call may still report on the reserve kept for it.
        if (asked.failure._tag === "SpendRefused" && step > 1 && Option.isSome(reserved)) {
          const closed = yield* closing(step + 1)
          if (closed.why.length > 0) return { _tag: "SpendRefused", message: `${asked.failure.message}; its closing call failed: ${closed.why}` } satisfies PassEnded
        }
        return asked.failure
      }
      const { answer, cut } = asked.success
      if (!cut && answer.toolCalls.length === 0) return { _tag: "Answered", summary: clipTo(answer.text.trim(), SUMMARY_KEPT) } satisfies PassEnded
      // Every call the answer asked for runs, also when the answer was cut: a call that did not decode is a failed result.
      for (const call of answer.toolCalls) {
        const path = call.name === READ_LINES || call.name === READ_DIFF ? Schema.decodeUnknownOption(OpenedPath)(call.params) : Option.none()
        if (Option.isSome(path)) opened.add(path.value.path)
        yield* kept(callTool(toolkit, call, session))
      }
      if (yield* judged) return { _tag: "Judged" } satisfies PassEnded
      if (cut) return { _tag: "OutputCut" } satisfies PassEnded
    }
    const closed = yield* closing(input.options.maxSteps + 1)
    if (yield* judged) return { _tag: "Judged" } satisfies PassEnded
    return { _tag: "StepCap", steps: input.options.maxSteps, ...closed } satisfies PassEnded
  }).pipe(Effect.ensuring(releaseReserve)))

  const model = parts.model.pipe(Layer.provide(Layer.succeed(ModelSpend, own)))
  const stack = Layer.mergeAll(parts.memory, parts.tools(input.reviewed), model).pipe(
    Layer.provideMerge(sessions()),
    Layer.provideMerge(parts.journal(input.journalAt)),
    Layer.provideMerge(kernel()),
  )
  const ended = yield* loop.pipe(
    Effect.provide(stack),
    Effect.catchTag("PassJournalFailed", (failed) => Effect.logWarning("a review pass's journal failed", failed).pipe(
      Effect.as<PassEnded>({ _tag: "JournalFailed", message: clipTo(failed.message, 300) }),
    )),
  )
  // A pass that ended before its first call returned says so: no answer.
  yield* signal(false)
  const result: PassResult = { stage, session: made, ended, calls, opened: Arr.sort(Array.from(opened), Order.String) }
  return result
})

/**
 * The passes and checks over the kernel (`runPass`), each part swappable (`KernelPassesOptions`): the model is the
 * host's layer, built for each pass over a ledger of its own inside the stage's `spend`; the tools read the host's
 * `Checkout` and record in its `Findings`.
 */
export const kernelPasses = (options: KernelPassesOptions): Layer.Layer<ReviewPasses, never, Checkout | Findings> => {
  const parts: Required<KernelPassesOptions> = {
    model: options.model,
    memory: options.memory ?? flatMemory,
    tools: options.tools ?? reviewToolHandlers,
    journal: options.journal ?? folderJournal,
  }
  return Layer.effect(ReviewPasses, Effect.gen(function* () {
    const needs = yield* Effect.context<Checkout | Findings>()
    return ReviewPasses.of({ run: (input) => runPass(input, parts).pipe(Effect.provide(needs)) })
  }))
}
