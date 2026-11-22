import { Array as Arr, Effect, Layer, Match, Option, Order, Predicate, Result, Schema, Stream } from "effect"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"
import { JournalStorage, kernel, messageOf, ModelSpend, Sessions, toolResult, userMessage } from "@xandreed/core"
import type { SessionId, SpendHold } from "@xandreed/core"
import { callTool, clipTo, flatMemory, Memory, modelAnswer, recoverTurns, retryable, sessions } from "@xandreed/sdk"
import type { OwnTools, ToolNeeds } from "@xandreed/sdk"
import { directoryJournal, isSpendRefusal } from "@xandreed/sdk/node"
import type { Checkout } from "./checkout.port.js"
import { Findings } from "./findings.port.js"
import { CHARS_PER_TOKEN, CLOSING_ASKS, CONTEXT_FULL, SUMMARY_KEPT, TurnJournalFailed } from "./review-turn.entity.js"
import { thoughtsOf, withThoughts } from "./review-turn.entity.functions.js"
import type { Thought } from "./review-turn.entity.functions.js"
import type { CallUsage, TurnEnded, TurnLimits, TurnResult } from "./review-turn.entity.js"
import { ReviewTurns } from "./review-turn.port.js"
import type { HostToolsOffered, TurnInput } from "./review-turn.port.js"
import { harvestNote, stepCapNote } from "./review-prompt.entity.functions.js"
import { reviewToolHandlers, reviewTools } from "./review-tools.adapter.js"
import { READ_DIFF, READ_LINES, REPORT_FINDING, VERDICT } from "./review-tools.entity.js"
import type { Reviewed } from "./review-tools.entity.js"
import { stageSpend } from "./stage-spend.adapter.js"

/** The owner a turn's session is created under in its journal. */
export const TURN_OWNER = "efferent-review"

/** The path a `readLines` or `readDiff` call names, when its parameters hold one. */
const OpenedPath = Schema.Struct({ path: Schema.String })

/** What a failure says, in its own words when it has them. */
const wordsOf = (error: unknown, otherwise: string): string =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message.length > 0 ? error.message : otherwise

/** A failure of the turn's journal (opening, recovering, reading or writing it) as the turn's own failure. */
const kept = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TurnJournalFailed, R> =>
  Effect.mapError(effect, (cause) => new TurnJournalFailed({ message: wordsOf(cause, "the journal failed"), cause }))

/** Whether a failed answer is the model's (a refused, cut or failed call), not the journal's. */
const isModels = (error: unknown): boolean => AiError.isAiError(error) || Predicate.isTagged(error, "ModelAnswerFailed")

/** Whether a failed call is worth making again: the model's failure whose reason says so (`retryable`), also as a stream's error part's cause. */
const worthAnotherTry = (error: unknown): boolean =>
  retryable(error) || (Predicate.isTagged(error, "ModelAnswerFailed") && Predicate.hasProperty(error, "cause") && retryable(error.cause))

/** Whether a failure is the model's own (`AiError`) and says that one of its tool calls' parameters is not JSON. */
const badParams = (error: unknown): boolean => AiError.isAiError(error) && Predicate.isTagged(error.reason, "ToolParameterValidationError")

/**
 * Whether an answer failed because a tool call's parameters were not JSON, also as a stream's error part's cause: the
 * Anthropic provider fails the whole answer then, before any of its calls is known, so no failed result can tell the
 * model. Measured on the review eval: one finder turn's harvest call was lost so (#463, draw 2).
 */
const malformedCall = (error: unknown): boolean =>
  badParams(error) || (Predicate.isTagged(error, "ModelAnswerFailed") && Predicate.hasProperty(error, "cause") && badParams(error.cause))

/**
 * Tools a host adds to the review's six: its toolkit, offered after them in every request of every turn and check, and
 * its handlers over what the turn reviews, as `reviewToolHandlers` are. The two are typed together, so handlers that
 * lack one of the toolkit's tools do not compile. The toolkit is also typed as what it yields, each tool with its own
 * type (`OwnTools`), so a call of a host's tool runs through `callTool` with what its tools declare checked: a toolkit
 * made with `Toolkit.make` or `Toolkit.merge` is both. Its descriptions and parameters are the host's text the model
 * reads, and none of its tools may take a name of the six (`NoStockNames`).
 */
export interface HostTools<Tools extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.Toolkit<Tools> & Effect.Effect<Toolkit.WithHandler<Tools> & OwnTools<Tools>, never, Tool.HandlersFor<Tools>>
  readonly handlers: (reviewed: Reviewed) => Layer.Layer<Tool.HandlersFor<Tools>, never, Checkout | Findings>
}

/**
 * A host's tools that take no name of the six: `Toolkit.merge` lets a later tool replace an earlier one of its name. A
 * toolkit keyed by any string (tools made from names known only at run time) may hold one, and is refused too.
 */
export type NoStockNames<Tools> = [Extract<keyof typeof reviewTools.tools, keyof Tools>] extends [never]
  ? unknown
  : "a host's tool cannot take the name of one of the review's six tools"

/** The toolkit every request offers: the review's six in their order, then the host's tools in theirs. */
const offeredWith = <Tools extends Record<string, Tool.Any>>(host: HostTools<Tools>) => Toolkit.merge(reviewTools, host.toolkit)

type Offered<Tools extends Record<string, Tool.Any>> = Toolkit.Tools<ReturnType<typeof offeredWith<Tools>>>

/**
 * What a host's tools need of the program beyond their handlers: what they declare (`ToolNeeds`) and what the offered
 * tools' parameters need to be sent. `never` for tools of plain schemas that declare nothing, as the six are.
 */
export type HostToolNeeds<Tools extends Record<string, Tool.Any>> =
  | ToolNeeds<Tools>
  | Tool.ParametersEncodingServices<Offered<Tools>[keyof Offered<Tools>]>

/**
 * What a host's tools add to every request (`HostToolsOffered`): their names in order, and their declarations' bytes
 * as the reviewer's wire (`openAiCompatibleModel`) sends each, `{"type":"function","function":{name, description,
 * parameters}}` and the comma before it.
 */
const offeredOf = <Tools extends Record<string, Tool.Any>>(host: HostTools<Tools>): HostToolsOffered => {
  const tools: ReadonlyArray<Tool.Any> = Object.values(host.toolkit.tools)
  const declared = tools.map((tool) => JSON.stringify({ type: "function", function: { name: tool.name, description: Tool.getDescription(tool) ?? "", parameters: Tool.getJsonSchema(tool) } }))
  return { names: tools.map((tool) => tool.name), declarationBytes: declared.reduce((sum, text) => sum + new TextEncoder().encode(text).length + 1, 0) }
}

/** The tools of a host that adds none, as `Toolkit.empty` holds them. */
type NoTools = Toolkit.Tools<typeof Toolkit.empty>

/** No tools of a host's: the six alone, as a review offers them. */
const NO_HOST_TOOLS: HostTools<NoTools> = { toolkit: Toolkit.empty, handlers: () => Layer.empty }

/**
 * What a turn runs on, each a part a host may swap: the model (a layer charging the `ModelSpend` it is given: each turn
 * builds it over a ledger of its own inside its stage's), the memory that builds each step's context (`flatMemory` by
 * default), the tools' handlers over what the turn reviews (`reviewToolHandlers` by default), the host's own tools
 * offered after the six (`HostTools`; none by default), and the journal kept at an input's `journalAt` (a
 * `directoryJournal` in that folder by default), whose failure to open is a `TurnJournalFailed`.
 */
export interface KernelTurnsOptions<Tools extends Record<string, Tool.Any> = NoTools> {
  readonly model: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>
  /** The checks' model, when it differs from the finder turns' (another reasoning effort): `model` by default. */
  readonly verifyModel?: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>
  readonly memory?: Layer.Layer<Memory>
  readonly tools?: typeof reviewToolHandlers
  readonly hostTools?: HostTools<Tools>
  readonly journal?: (at: string) => Layer.Layer<JournalStorage, TurnJournalFailed>
  /**
   * Whether each answer's thinking that came with the provider's metadata (a signature) is sent back, as it came, at
   * the start of that answer in every later request of the turn (`withThoughts`): on by default. The journal does not
   * keep it, so it lives as long as the turn. A model that sends no such thinking (the OpenAI-compatible wire sends
   * none) makes every request what it is without it.
   */
  readonly replayThinking?: boolean
  /**
   * The most input tokens a request of the turn may reach, for a model billed at a higher price past a size (a
   * provider may bill a long request at several times the price): before each call of an answer, the next request is
   * estimated as the answer's own request and output plus what the calls before it stored (`CHARS_PER_TOKEN`), and
   * once that reaches this limit every further call but the reporting one is answered `CONTEXT_FULL` without running.
   * None by default: every call runs.
   */
  readonly readTokens?: number
}

/** The stock journal: a `directoryJournal` in the folder `at`, a refusal to open it a `TurnJournalFailed`. */
const folderJournal = (at: string): Layer.Layer<JournalStorage, TurnJournalFailed> =>
  directoryJournal({ directory: at }).pipe(
    Layer.catchTag("JournalOpenFailed", (cause) => Layer.effect(JournalStorage, Effect.fail(new TurnJournalFailed({ message: wordsOf(cause, "the journal could not be opened"), cause })))),
  )

/**
 * One turn, a finder's or a check's, over the kernel: a session in the journal at `journalAt` (its turns recovered
 * first), the memory, the review's tools and the host's after them, the model over a ledger of the turn's own inside its
 * stage's (`stageSpend`, so each call's cost is what that ledger settled while it ran, whatever runs beside it), and the
 * host's loop with `modelAnswer` and `callTool`. Each step sends the prompt's prefix, then what the memory gives (the
 * tail message, the calls and their results); a call of a host's tool runs as a call of the six does, through the
 * host's toolkit. It ends when the model answers without a call (a finder turn is first asked once more for
 * what it weighed and did not report, `harvestNote`, and only that answer's `reportFinding` calls run); for a check,
 * once its verdict is recorded; when the ledger refuses a call, when a call fails, when an answer is cut at the output
 * cap (its finish says `length`; the calls it asked for run first, so a finding it reported is kept), or when the
 * journal fails: each with the findings recorded so far. From its start it holds back `options.reserve` from its stage
 * for its closing call; at its step cap, or when the ledger refuses a later call while that reserve is held, it releases
 * the reserve, stores the host's note (`stepCapNote`) and asks once more, offering the same tools so the provider's
 * cache holds, and runs only the calls that report (`reportFinding` in a finder turn, `verdict` in a check), asking once
 * more when the tool refused one of them (`CLOSING_ASKS`); a closing call that fails is said in `StepCap`'s `why`.
 * `onFirstAnswer` is given, once, whether its first call answered (`false` when it ended before one returned); when it
 * is given, the other turns wait on that call, so a failure of it worth another try (`retryable`: a rate limit, a
 * provider's error, a lost connection) is asked once more first; so is it with `retryFirstCall` (a focused group's turn).
 */
const runTurn = <Tools extends Record<string, Tool.Any>>(parts: Required<KernelTurnsOptions<Tools>>) => Effect.fn("review.turn")(function* (input: TurnInput) {
  const own = yield* stageSpend(input.spend, Option.none())
  const settled = Effect.map(Effect.orDie(own.totals), (totals) => totals.settled)
  const findings = yield* Findings
  const stage = input.reviewed.stage
  const reports = Match.valueTags(stage, { Find: () => REPORT_FINDING, Verify: () => VERDICT })
  const checking = Match.valueTags(stage, { Find: () => false, Verify: () => true })
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
      return input.spend.release(hold).pipe(Effect.tapError((error) => Effect.logWarning("a review turn's reserve could not be released", error)), Effect.ignore)
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
    const hostToolkit = yield* parts.hostTools.toolkit
    const offered = offeredWith(parts.hostTools)
    const conversations = yield* Sessions
    const id = yield* kept(conversations.create({ owner: TURN_OWNER }))
    made = Option.some(id)
    const session = yield* kept(conversations.open(id))
    yield* kept(session.append(userMessage(input.prompt.tail)))
    // What the closing call will need, held back from the stage now; a stage with no room for it goes on without.
    if (input.options.reserve > 0) reserved = yield* input.spend.keepBack(input.options.reserve)

    // Each answer's thinking, by its first call's id, for the later requests of this turn (`replayThinking`).
    const thoughts = new Map<string, ReadonlyArray<Thought>>()

    /** One model call: its answer and whether it was cut at the output cap, or how the turn ends when it failed. */
    const ask = (step: number) => Effect.gen(function* () {
      const context = yield* kept(memory.context(session))
      const prompt = Prompt.make([...input.prompt.prefix, ...(parts.replayThinking ? withThoughts(context, thoughts) : context)])
      let finish = ""
      // The parts of the attempt being read: a try asked again starts them anew.
      let seen: Array<Response.AnyPart> = []
      const stream = Stream.suspend(() => {
        seen = []
        return LanguageModel.streamText({ prompt, toolkit: offered, disableToolCallResolution: true, toolCallValidation: "deferred" })
      }).pipe(
        Stream.tap((part) => Effect.sync(() => {
          if (part.type === "finish") finish = part.reason
          if (part.type === "reasoning-start" || part.type === "reasoning-delta") seen.push(part)
        })),
      )
      /** What the turn's own ledger settled since `before`, rounded past the float noise of a difference. */
      const spentSince = (before: number) => Effect.map(settled, (now) => Math.max(0, Math.round((now - before) * 1e12) / 1e12))
      const before = yield* settled
      const tried = yield* Effect.result(modelAnswer(stream, session))
      // The call the other turns wait on is asked once more after a failure worth another try (a rate limit, a
      // provider's error, a lost connection): one blip would otherwise end the whole find stage. So is any call whose
      // answer failed on a tool call's parameters that were not JSON (`malformedCall`): its calls are lost whole, a
      // closing call's reports with them. A failed answer stores nothing, so the second try is the same request; the
      // failed one is a call of its own in the record. Once, either way.
      const blip = Result.isFailure(tried) && step === 1 && (input.onFirstAnswer !== undefined || input.retryFirstCall === true) && worthAnotherTry(tried.failure)
      const malformed = Result.isFailure(tried) && malformedCall(tried.failure)
      const again = blip || malformed
      if (Result.isFailure(tried) && again) {
        calls.push({ step, tokens: Option.none(), cost: yield* spentSince(before) })
        yield* Effect.logWarning(malformed ? "a review turn's call answered with a tool call that was not JSON and is asked once more" : "a review turn's first call failed and is asked once more", wordsOf(tried.failure, "the model call failed"))
      }
      const retriedAt = yield* settled
      const answered = again ? yield* Effect.result(modelAnswer(stream, session)) : tried
      const cost = yield* spentSince(again ? retriedAt : before)
      yield* signal(Result.isSuccess(answered))
      if (Result.isFailure(answered)) {
        calls.push({ step, tokens: Option.none(), cost })
        const error = answered.failure
        if (!isModels(error)) return yield* Effect.fail(new TurnJournalFailed({ message: wordsOf(error, "the journal failed"), cause: error }))
        return Result.fail<TurnEnded>(isSpendRefusal(error)
          ? { _tag: "SpendRefused", message: wordsOf(error, "the spend cap refused the call") }
          : { _tag: "ModelFailed", message: wordsOf(error, "the model call failed") })
      }
      const answer = answered.success
      const first = answer.toolCalls[0]
      const thought = thoughtsOf(seen)
      if (parts.replayThinking && first !== undefined && thought.length > 0) thoughts.set(first.id, thought)
      calls.push({ step, tokens: Option.map(answer.usage, (usage) => ({ input: usage.inputTokens, cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens })), cost })
      return Result.succeed({ answer, cut: finish === "length" })
    })

    /**
     * The closing call, at the step cap, after a spend refusal, for a check after an answer with no verdict, or for a
     * finder turn after its answer in words (`harvestNote`): the reserve released, the host's note, then one more call
     * whose reporting calls alone run. Its words, or why it failed.
     */
    const closing = (step: number, note: string = stepCapNote(stage)) => Effect.gen(function* () {
      yield* releaseReserve
      yield* kept(session.append(userMessage(note)))
      let summary = ""
      // A reporting call the tool refused (a path it does not change, lines out of order) is lost unless asked again:
      // the refusal says what to give, so the model is asked once more, at most `CLOSING_ASKS` calls in all.
      for (let asked = 0; asked < CLOSING_ASKS; asked++) {
        const last = yield* ask(step + asked)
        if (Result.isFailure(last)) return { summary, why: "message" in last.failure ? last.failure.message : last.failure._tag }
        let refused = false
        for (const call of last.success.answer.toolCalls.filter((call) => call.name === reports)) {
          const stored = yield* kept(callTool(toolkit, call, session))
          if (Option.exists(messageOf(stored), (message) => Predicate.isTagged(message, "ToolResult") && message.isFailure)) refused = true
        }
        summary = clipTo(last.success.answer.text.trim(), SUMMARY_KEPT)
        if (!refused) break
      }
      return { summary, why: "" }
    })

    for (let step = 1; step <= input.options.maxSteps; step++) {
      const asked = yield* ask(step)
      if (Result.isFailure(asked)) {
        // A spend refusal after the first call: the closing call may still report on the reserve kept for it.
        if (asked.failure._tag === "SpendRefused" && step > 1 && Option.isSome(reserved)) {
          const closed = yield* closing(step + 1)
          if (yield* judged) return { _tag: "Judged" } satisfies TurnEnded
          if (closed.why.length > 0) return { _tag: "SpendRefused", message: `${asked.failure.message}; its closing call failed: ${closed.why}` } satisfies TurnEnded
        }
        return asked.failure
      }
      const { answer, cut } = asked.success
      if (!cut && answer.toolCalls.length === 0) {
        const answered: TurnEnded = { _tag: "Answered", summary: clipTo(answer.text.trim(), SUMMARY_KEPT) }
        // A finder turn that answers in words is asked once more to report what it weighed and kept to itself
        // (`harvestNote`): the checks settle every report. Its summary stays the first answer's; a failed harvest is logged.
        if (!checking) {
          const harvested = yield* closing(step + 1, harvestNote())
          if (harvested.why.length > 0) yield* Effect.logWarning("a review turn's harvest call failed", harvested.why)
          return answered
        }
        // A check that answers in words gave no verdict (a verdict in text has no quote to check): it is asked once
        // more, with the host's note, for the verdict call.
        yield* closing(step + 1)
        return (yield* judged) ? { _tag: "Judged" } satisfies TurnEnded : answered
      }
      // Every call the answer asked for runs, also when the answer was cut: a call that did not decode is a failed result.
      // Past the model's read limit (`readTokens`), a call that does not report is answered in fixed words instead.
      const requested = Option.match(answer.usage, { onNone: () => 0, onSome: (usage) => usage.inputTokens + usage.outputTokens })
      let added = 0
      for (const call of answer.toolCalls) {
        if (call.name !== reports && requested + added / CHARS_PER_TOKEN >= parts.readTokens) {
          yield* kept(session.append(toolResult(call, CONTEXT_FULL[stage._tag], true)))
          continue
        }
        const path = call.name === READ_LINES || call.name === READ_DIFF ? Schema.decodeUnknownOption(OpenedPath)(call.params) : Option.none()
        if (Option.isSome(path)) opened.add(path.value.path)
        // A host's tool runs through the host's toolkit; any other name, one no toolkit has included, through the six's.
        const stored = yield* kept(Object.hasOwn(hostToolkit.tools, call.name) ? callTool(hostToolkit, call, session) : callTool(toolkit, call, session))
        added += Option.match(messageOf(stored), { onNone: () => 0, onSome: (message) => JSON.stringify(message).length })
      }
      if (yield* judged) return { _tag: "Judged" } satisfies TurnEnded
      if (cut) return { _tag: "OutputCut" } satisfies TurnEnded
    }
    const closed = yield* closing(input.options.maxSteps + 1)
    if (yield* judged) return { _tag: "Judged" } satisfies TurnEnded
    return { _tag: "StepCap", steps: input.options.maxSteps, ...closed } satisfies TurnEnded
  }).pipe(Effect.ensuring(releaseReserve)))

  const model = (checking ? parts.verifyModel : parts.model).pipe(Layer.provide(Layer.succeed(ModelSpend, own)))
  const stack = Layer.mergeAll(parts.memory, parts.tools(input.reviewed), parts.hostTools.handlers(input.reviewed), model).pipe(
    Layer.provideMerge(sessions()),
    Layer.provideMerge(parts.journal(input.journalAt)),
    Layer.provideMerge(kernel()),
  )
  const ended = yield* loop.pipe(
    Effect.provide(stack),
    Effect.catchTag("TurnJournalFailed", (failed) => Effect.logWarning("a review turn's journal failed", failed).pipe(
      Effect.as<TurnEnded>({ _tag: "JournalFailed", message: clipTo(failed.message, 300) }),
    )),
  )
  // A turn that ended before its first call returned says so: no answer.
  yield* signal(false)
  const result: TurnResult = { stage, session: made, ended, calls, opened: Arr.sort(Array.from(opened), Order.String) }
  return result
})

/** The turns over their parts: what the tools need, the host's included (`HostToolNeeds`), is the layer's to be given. */
const turnsOver = <Tools extends Record<string, Tool.Any>>(parts: Required<KernelTurnsOptions<Tools>>): Layer.Layer<ReviewTurns, never, Checkout | Findings | HostToolNeeds<Tools>> => {
  const run = runTurn(parts)
  const hostTools = offeredOf(parts.hostTools)
  const limits: TurnLimits = {
    replayThinking: parts.replayThinking,
    readTokens: Number.isFinite(parts.readTokens) ? Option.some(parts.readTokens) : Option.none(),
  }
  return Layer.effect(ReviewTurns, Effect.gen(function* () {
    const needs = yield* Effect.context<Checkout | Findings | HostToolNeeds<Tools>>()
    return ReviewTurns.of({ run: (input) => run(input).pipe(Effect.provide(needs)), hostTools, limits })
  }))
}

/**
 * The finder turns and the checks over the kernel (`runTurn`), each part swappable (`KernelTurnsOptions`): the model is
 * the host's layer, built for each turn over a ledger of its own inside the stage's `spend`; the tools read the host's
 * `Checkout` and record in its `Findings`. A host's tools (`hostTools`) are offered after the six and their calls run
 * in every step; what they need beyond their handlers (`HostToolNeeds`, `never` for plain tools) the layer needs too.
 * With none, every request is the six's alone, as before there were host tools.
 */
export const kernelTurns = <Tools extends Record<string, Tool.Any> = NoTools>(options: KernelTurnsOptions<Tools> & NoStockNames<Tools>): Layer.Layer<ReviewTurns, never, Checkout | Findings | HostToolNeeds<Tools>> => {
  const parts = {
    model: options.model,
    verifyModel: options.verifyModel ?? options.model,
    memory: options.memory ?? flatMemory,
    replayThinking: options.replayThinking ?? true,
    readTokens: options.readTokens ?? Number.POSITIVE_INFINITY,
    tools: options.tools ?? reviewToolHandlers,
    journal: options.journal ?? folderJournal,
  }
  return options.hostTools === undefined ? turnsOver({ ...parts, hostTools: NO_HOST_TOOLS }) : turnsOver({ ...parts, hostTools: options.hostTools })
}
