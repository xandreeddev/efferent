import { Cause, Context, Effect, Exit, Option } from "effect"
import { CurrentToolResultReceipt } from "@xandreed/core/internal"
import {
  harnessDefectsAsFailures,
  replayableContext,
  RunContext,
  sessionAttributes,
  turnAttributes,
  turnEndingOf,
  TurnEvents,
  TurnMemory,
  TurnTasks,
  TurnToolbox,
} from "@xandreed/core"
import type {
  AdmittedTurn,
  ConversationId,
  RunId,
  RunTools,
  StepLoop,
  TokenUsage,
  Turn,
  TurnError,
  TurnOutcome,
  TurnResult,
  TurnRunOptions,
  TurnTools,
  TurnWriter,
} from "@xandreed/core"
import { runTurnLoop } from "./turn-run.usecase.functions.js"
import type { TurnRunServices } from "./turn-run.usecase.functions.js"

const failed: TurnOutcome = { outcome: "failed", reply: Option.none() }

/**
 * Open the turn's tools (once). Their handlers run with the services of where this runs: open them inside the host's layer.
 *
 * @public
 */
export const openTurnTools: Effect.Effect<RunTools, TurnError, TurnToolbox> =
  TurnToolbox.pipe(Effect.flatMap((toolbox) => toolbox.open))

/**
 * The host's view of the open tools; skills the host activates are recorded
 * as its own.
 *
 * @public
 */
export const turnTools: Effect.Effect<TurnTools, TurnError, TurnToolbox> = TurnToolbox.pipe(
  Effect.flatMap((toolbox) => toolbox.tools),
  Effect.map((tools): TurnTools => ({
    match: tools.match,
    apply: tools.apply,
    select: tools.select,
    activate: (skills) => tools.activate(skills, "host"),
    active: tools.active,
    skills: tools.skills,
  })),
)

/**
 * Await the tasks, then drain the background reactions, again until a round starts nothing new.
 *
 * @public
 */
export const settleTurn: Effect.Effect<void, TurnError, TurnEvents | TurnTasks> = Effect.gen(function* () {
  const events = yield* TurnEvents
  const tasks = yield* TurnTasks
  const activity = Effect.zipWith(tasks.activity, events.activity, (forked, delivered) => forked + delivered)
  const settle: Effect.Effect<void, TurnError> = Effect.gen(function* () {
    const before = yield* activity
    yield* tasks.await([])
    yield* events.drain
    if ((yield* activity) !== before) yield* Effect.suspend(() => settle)
  })
  yield* settle
})

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** A secondary failure while a failed turn ends: logged, never replacing the turn's own cause (an interruption is not logged). */
const logFailure = (message: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> => effect.pipe(
  Effect.exit,
  Effect.flatMap(Exit.match({
    onSuccess: () => Effect.void,
    onFailure: (cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, cause),
  })),
)

/**
 * Record the reply, then drain the reactions to it with `restore`'s
 * interruptibility, then flush the journal whatever the drain did. The
 * reply waits for the turn's closing commit, so when any of it fails (or
 * the drain is cut) the reply is downgraded to failed before the failure
 * goes on: the end stores a failed reply, never a completed one beside a
 * failed or interrupted end. Runs where interruption is masked.
 */
const finishing = (restore: Restore, outcome: TurnOutcome): Effect.Effect<void, TurnError, TurnMemory | TurnEvents | RunContext> => Effect.gen(function* () {
  const memory = yield* TurnMemory
  const finished = yield* Effect.exit(Effect.gen(function* () {
    yield* memory.persistReply(outcome)
    const drained = yield* Effect.exit(restore((yield* TurnEvents).drain))
    yield* (yield* RunContext).flush
    return yield* drained
  }))
  if (Exit.isSuccess(finished)) return
  yield* memory.persistReply(failed).pipe(logFailure("the turn's reply was not downgraded to failed"))
  return yield* Effect.failCause(finished.cause)
})

/**
 * Record the reply (`persistReply`), drain the reactions to it, and flush
 * the journal. The reply is recorded and the journal flushed even when the
 * fiber is interrupted meanwhile; only the drain can be cut. The reply is
 * stored with the turn's end; when the drain or the flush fails, or the
 * drain is cut, it is downgraded to failed first.
 *
 * @public
 */
export const finishTurn = (outcome: TurnOutcome): Effect.Effect<void, TurnError, TurnMemory | TurnEvents | RunContext> =>
  Effect.uninterruptibleMask((restore) => finishing(restore, outcome))

/**
 * How long a turn that failed waits for the background reactions to its
 * failed reply: past it, the turn ends without them, so a stuck subscriber
 * cannot hold up the end. A turn that was interrupted does not wait for them.
 */
const failedReactionsWait = "10 seconds"

/**
 * The end of a turn that failed or was interrupted: its reply recorded as
 * failed, the reactions to it drained, interruptibly and within
 * `failedReactionsWait`, the journal flushed, and the usage its provider
 * calls spent so far put on the current span. Runs where interruption is
 * masked; what fails here is logged.
 */
const finishFailed: Effect.Effect<void, never, TurnMemory | TurnEvents | RunContext> = Effect.gen(function* () {
  const run = yield* RunContext
  yield* (yield* TurnMemory).persistReply(failed).pipe(logFailure("the failed turn's reply was not recorded"))
  // Interruptible around the bound: a cancel cuts the wait at once, rather than when the bound runs out.
  const settled = yield* (yield* TurnEvents).drain.pipe(Effect.timeoutOption(failedReactionsWait), Effect.interruptible, Effect.exit)
  yield* Exit.match(settled, {
    onSuccess: Option.match({
      onSome: () => Effect.void,
      onNone: () => Effect.logWarning(`the reactions to the failed turn's reply did not settle within ${failedReactionsWait}; the turn ends without them`),
    }),
    onFailure: (cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("the reactions to the failed turn's reply failed", cause),
  })
  yield* run.flush.pipe(logFailure("the failed turn's journal was not flushed"))
  yield* Effect.annotateCurrentSpan(turnUsageAttributes(yield* run.usage))
})

/**
 * Run a turn's body to its end: once it succeeds, the turn settles (tasks
 * and background reactions) and finishes with its outcome, returned with
 * the turn's usage (`RunContext.usage`, the same total `turn.ended`
 * carries). Once the body has returned, its reply is recorded and the
 * journal flushed even when the turn is interrupted then; an interruption
 * cuts only the drain of the reactions to the reply. The reply is stored
 * with the turn's end (`TurnWriter.closing`): when that finishing fails or
 * is cut, the turn fails with its cause and the reply is downgraded to
 * failed, so the end never stores a completed reply. When the body fails or
 * is interrupted, the turn finishes as failed and keeps the body's cause:
 * the failed reply is recorded, the reactions to it are waited for at most
 * ten seconds (not at all once interrupted), a failure of that finishing is
 * logged, and the usage its provider calls spent so far goes on the current
 * span as `efferent.usage.*_tokens` (the turn's `agent.turn` when
 * `guardTurn` runs under `traceTurn` with no span between, as in
 * `Agent.turn`; `traceTurn` records it itself when the turn returns). A
 * `TurnError` carried as a defect (a subscriber's or the writer's failure
 * behind a `never` error channel) fails the turn, typed.
 *
 * @public
 */
export const guardTurn = <E, R>(body: Effect.Effect<TurnOutcome, E, R>): Effect.Effect<
  TurnResult,
  E | TurnError,
  R | TurnMemory | TurnEvents | TurnTasks | RunContext
> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
  const exit = yield* Effect.exit(restore(harnessDefectsAsFailures(body.pipe(Effect.tap(() => settleTurn)))))
  if (Exit.isFailure(exit)) {
    yield* finishFailed
    return yield* Effect.failCause(exit.cause)
  }
  const outcome = exit.value
  yield* finishing(restore, outcome)
  const usage = yield* (yield* RunContext).usage
  return { outcome: outcome.outcome, reply: outcome.reply, usage } satisfies TurnResult
}))

/**
 * The `Turn` a host's code works with, over the turn's services (the one
 * `Agent.turn` hands to `use`): its `run` is `runTurnLoop` with `options`,
 * its spans under the span current where `run` is called. The message must
 * be persisted and the tools open.
 *
 * @public
 */
export const turnOf = Effect.fnUntraced(function* (options: TurnRunOptions = {}): Effect.fn.Return<Turn, TurnError, TurnRunServices | RunContext | StepLoop> {
  const services = Context.omit(CurrentToolResultReceipt)(replayableContext(yield* Effect.context<TurnRunServices | StepLoop>()))
  const run = yield* RunContext
  const memory = yield* TurnMemory
  return {
    conversation: run.conversation,
    runId: run.runId,
    turn: yield* memory.number,
    userMessage: run.userMessage,
    admitted: run.admitted,
    memory: run.memory,
    events: run.events,
    tasks: run.tasks,
    tools: yield* turnTools,
    context: memory.context,
    reply: (text) => Effect.succeed<TurnOutcome>({ outcome: "completed", reply: Option.some(text) }),
    run: (policy) => runTurnLoop(policy, options).pipe(Effect.provide(services)),
    usage: run.usage,
    flush: run.flush,
    write: run.write,
  } satisfies Turn
})

/**
 * What a turn's span (`traceTurn`) shows besides the turn's ids.
 *
 * @public
 */
export interface TurnTraceOptions {
  /**
   * The keys of the turn's metadata (`AdmittedTurn.meta`) whose values the
   * span carries, as `efferent.meta.<key>`: none by default, since metadata
   * may hold what a trace backend should not (a user, a tenant). A string,
   * number or boolean is kept as it is, anything else as its JSON; a key the
   * turn's metadata lacks is left out.
   */
  readonly spanMeta?: ReadonlyArray<string>
}

const metaAttribute = (value: unknown): unknown =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value)

/** The turn's span attributes as it starts: its ids, the conversation, its origin, the turn it resumes and the allowed metadata. */
const turnSpanAttributes = (admitted: AdmittedTurn, spanMeta: ReadonlyArray<string>): Record<string, unknown> => ({
  ...turnAttributes(admitted),
  "gen_ai.conversation.id": admitted.session.id,
  "efferent.origin": admitted.origin,
  ...(admitted.resumes === undefined ? {} : { "efferent.resumes": admitted.resumes }),
  ...Object.fromEntries(spanMeta.filter((key) => Object.hasOwn(admitted.meta, key)).map((key) => [`efferent.meta.${key}`, metaAttribute(admitted.meta[key])])),
})

/** A turn's usage as span attributes, under efferent's names (the GenAI names belong to the calls). */
const turnUsageAttributes = (usage: TokenUsage): Record<string, number> => ({
  "efferent.usage.input_tokens": usage.inputTokens,
  "efferent.usage.output_tokens": usage.outputTokens,
  "efferent.usage.cache_read_tokens": usage.cacheReadTokens,
  "efferent.usage.cache_write_tokens": usage.cacheWriteTokens,
  "efferent.usage.reasoning_tokens": usage.reasoningTokens,
  "efferent.usage.total_tokens": usage.totalTokens,
})

/** How the turn ended, as span attributes: `turnEndingOf` its exit, and the usage of a turn that returned (`guardTurn` records a failed turn's). */
const turnEndAttributes = (exit: Exit.Exit<TurnResult, unknown>): Record<string, unknown> => {
  const ending = turnEndingOf(exit)
  return {
    "efferent.outcome": ending.reason,
    ...Option.match(ending.failure, { onNone: () => ({}), onSome: (failure) => ({ "efferent.failure.code": failure.code }) }),
    ...Exit.match(exit, { onSuccess: (result) => turnUsageAttributes(result.usage), onFailure: () => ({}) }),
  }
}

/**
 * Run a turn under its span, `agent.turn`, the root of everything the turn
 * does (under the caller's span, if any). It starts once the turn is
 * admitted (`writer`), with `efferent.session.id`, `efferent.run.id`,
 * `efferent.turn`, `gen_ai.conversation.id` (the session), `efferent.origin`,
 * `efferent.resumes` (on a resume) and `options.spanMeta`'s
 * `efferent.meta.<key>`; every span under it
 * carries the first three too. It ends with `efferent.outcome` (the
 * `TurnEnding` reason of the turn's exit: completed, partial, failed or
 * interrupted; a turn cancelled or reaped while it ran shows as failed with
 * `turn.closed`, its `TurnClosed`'s code), `efferent.failure.code` when the turn failed or was
 * interrupted, and the turn's usage
 * (`efferent.usage.{input,output,cache_read,cache_write,reasoning,total}_tokens`):
 * when it returned, from its result; when it failed, what `guardTurn`
 * records, so `guardTurn` runs under this span with no span between.
 * `Agent.turn` encloses everything after `Sessions.begin`
 * in it: the turn-dependent plugins, the host's layer, the tools opened, `use`,
 * the reply and the end; a host composing its own turn wraps the same. The
 * begin itself has its own span beside this one (`traceTurnBegin`).
 *
 * @public
 */
export const traceTurn = (writer: TurnWriter, options: TurnTraceOptions = {}) =>
  <E, R>(effect: Effect.Effect<TurnResult, E, R>): Effect.Effect<TurnResult, E, R> =>
    effect.pipe(
      Effect.onExit((exit) => Effect.annotateCurrentSpan(turnEndAttributes(exit))),
      Effect.annotateSpans(turnAttributes(writer.admitted)),
      Effect.withSpan("agent.turn", { attributes: turnSpanAttributes(writer.admitted, options.spanMeta ?? []) }),
    )

/**
 * A turn about to begin, as its begin span (`traceTurnBegin`) names it.
 *
 * @public
 */
export interface TurnBeginTrace {
  readonly session: ConversationId
  readonly runId: RunId
  /** Who begins it: a user (a `User` begin), the inbox (an `Inbox` begin) or a background task (a `Task` begin). */
  readonly origin: AdmittedTurn["origin"]
}

/** The begin's ids, on its span and its logs. */
const beginAttributes = (begin: TurnBeginTrace): Record<string, unknown> => ({
  ...sessionAttributes(begin.session),
  "efferent.run.id": begin.runId,
})

/** How a begin ended, as span attributes: the turn it began, or the failure's code (`turnEndingOf`, the code `agent.turn` would give). */
const beginEndAttributes = (exit: Exit.Exit<{ readonly admitted: AdmittedTurn }, unknown>): Record<string, unknown> => Exit.match(exit, {
  onSuccess: (begun) => ({ "efferent.turn": begun.admitted.turn }),
  onFailure: (cause) => Option.match(turnEndingOf(Exit.failCause(cause)).failure, {
    onNone: () => ({}),
    onSome: (failure) => ({ "efferent.failure.code": failure.code }),
  }),
})

/**
 * Run the work that begins a turn under its span, `agent.turn.begin`, a
 * sibling of the turn's `agent.turn` under the caller's span (if any). It
 * starts with `efferent.session.id`, `efferent.run.id` and `efferent.origin`,
 * and ends with `efferent.turn` once the turn begins, or with
 * `efferent.failure.code` when it cannot (the refusal's code, as
 * `harnessCodeOf` gives it: `session.busy`, `turn.duplicate`…; else
 * `turn.failed`, `turn.defect` or `turn.interrupted`). The work's logs carry
 * the session and run ids as annotations. The work returns what names the
 * admitted turn: its `TurnWriter` (`Sessions.begin`), or a value holding the
 * admitted turn under `admitted`. `Agent.turn` encloses the session-scoped
 * plugins' activation and `Sessions.begin` in it when it begins the turn
 * itself; a turn the host began (its writer passed in) has no begin span. A
 * host composing its own turn wraps its begin the same way, then the rest
 * in `traceTurn`.
 *
 * @public
 */
export const traceTurnBegin = (begin: TurnBeginTrace) =>
  <A extends { readonly admitted: AdmittedTurn }, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.onExit((exit) => Effect.annotateCurrentSpan(beginEndAttributes(exit))),
      Effect.annotateLogs(beginAttributes(begin)),
      Effect.withSpan("agent.turn.begin", { attributes: { ...beginAttributes(begin), "efferent.origin": begin.origin } }),
    )
