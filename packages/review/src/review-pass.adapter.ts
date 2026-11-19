import { Array as Arr, Effect, Layer, Option, Order, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { kernel, ModelSpend, Sessions, userMessage } from "@xandreed/core"
import { callTool, clipTo, flatMemory, Memory, modelAnswer, recoverTurns, sessions } from "@xandreed/sdk"
import { directoryJournal, isSpendRefusal } from "@xandreed/sdk/node"
import type { Checkout } from "./checkout.port.js"
import type { Findings } from "./findings.port.js"
import { SUMMARY_KEPT } from "./review-pass.entity.js"
import type { CallUsage, PassEnded, PassResult } from "./review-pass.entity.js"
import { ReviewPasses } from "./review-pass.port.js"
import type { PassInput } from "./review-pass.port.js"
import { reviewToolHandlers, reviewTools } from "./review-tools.adapter.js"
import { READ_DIFF, READ_LINES } from "./review-tools.entity.js"

/** The owner a pass's session is created under in its journal. */
export const PASS_OWNER = "efferent-review"

/** The path a `readLines` or `readDiff` call names, when its parameters hold one. */
const OpenedPath = Schema.Struct({ path: Schema.String })

/** What a failed call says, in its own words when it has them. */
const wordsOf = (error: unknown): string =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message.length > 0 ? error.message : "the model call failed"

/**
 * One pass over the kernel: a session in a directory journal of its own (`journalDir`, its turns recovered first),
 * plain `flatMemory`, the review's tools, and the host's loop with `modelAnswer` and `callTool`. Each step sends the
 * prompt's prefix, then what the memory gives (the tail message, the calls and their results). The pass ends when
 * the model answers without a call, at its step cap, when the ledger refuses a call, when a call fails, or when an
 * answer is cut at the output cap (its finish says `length`): each with the findings recorded so far. Each call's
 * cost is what the ledger settled while it ran, so the passes run one after another.
 */
const runPass = Effect.fn("review.pass")(function* (input: PassInput) {
  const spend = yield* ModelSpend
  const settled = Effect.map(Effect.orDie(spend.totals), (totals) => totals.settled)
  const calls: Array<CallUsage> = []
  const opened = new Set<string>()

  const loop = Effect.scoped(Effect.gen(function* () {
    yield* Effect.orDie(recoverTurns)
    const memory = yield* Memory
    const toolkit = yield* reviewTools
    const conversations = yield* Sessions
    const id = yield* Effect.orDie(conversations.create({ owner: PASS_OWNER }))
    const session = yield* Effect.orDie(conversations.open(id))
    yield* Effect.orDie(session.append(userMessage(input.prompt.tail)))
    for (let step = 1; step <= input.options.maxSteps; step++) {
      const context = yield* Effect.orDie(memory.context(session))
      const prompt = Prompt.make([...input.prompt.prefix, ...context])
      let finish = ""
      const stream = LanguageModel.streamText({ prompt, toolkit: reviewTools, disableToolCallResolution: true, toolCallValidation: "deferred" }).pipe(
        Stream.tap((part) => Effect.sync(() => {
          if (part.type === "finish") finish = part.reason
        })),
      )
      const before = yield* settled
      const answered = yield* Effect.result(modelAnswer(stream, session))
      // What the ledger settled while the call ran, rounded past the float noise of a difference.
      const cost = Math.max(0, Math.round(((yield* settled) - before) * 1e12) / 1e12)
      if (Result.isFailure(answered)) {
        calls.push({ step, tokens: Option.none(), cost })
        const error = answered.failure
        return isSpendRefusal(error) ? { _tag: "SpendRefused", message: wordsOf(error) } satisfies PassEnded : { _tag: "ModelFailed", message: wordsOf(error) } satisfies PassEnded
      }
      const answer = answered.success
      calls.push({ step, tokens: Option.map(answer.usage, (usage) => ({ input: usage.inputTokens, cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens })), cost })
      if (finish === "length") return { _tag: "OutputCut" } satisfies PassEnded
      if (answer.toolCalls.length === 0) return { _tag: "Answered", summary: clipTo(answer.text.trim(), SUMMARY_KEPT) } satisfies PassEnded
      for (const call of answer.toolCalls) {
        const path = call.name === READ_LINES || call.name === READ_DIFF ? Schema.decodeUnknownOption(OpenedPath)(call.params) : Option.none()
        if (Option.isSome(path)) opened.add(path.value.path)
        yield* Effect.orDie(callTool(toolkit, call, session))
      }
    }
    return { _tag: "StepCap", steps: input.options.maxSteps } satisfies PassEnded
  }))

  const stack = Layer.mergeAll(flatMemory, reviewToolHandlers(input.reviewed)).pipe(
    Layer.provideMerge(sessions()),
    Layer.provideMerge(directoryJournal({ directory: input.journalDir })),
    Layer.provideMerge(kernel()),
  )
  const ended = yield* loop.pipe(Effect.provide(stack))
  const result: PassResult = { pass: input.reviewed.pass, ended, calls, opened: Arr.sort(Array.from(opened), Order.String) }
  return result
})

/**
 * The passes over the kernel (`runPass`): the model is the `LanguageModel` the host provides, charged to its
 * `ModelSpend`; the tools read the host's `Checkout` and record in its `Findings`.
 */
export const kernelPasses: Layer.Layer<ReviewPasses, never, LanguageModel.LanguageModel | ModelSpend | Checkout | Findings> = Layer.effect(ReviewPasses, Effect.gen(function* () {
  const needs = yield* Effect.context<LanguageModel.LanguageModel | ModelSpend | Checkout | Findings>()
  return ReviewPasses.of({ run: (input) => runPass(input).pipe(Effect.provide(needs)) })
}))
