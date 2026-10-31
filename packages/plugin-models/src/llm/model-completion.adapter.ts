import { Cause, Clock, Deferred, Effect, Exit, Option, Ref, Schema } from "effect"
import { CurrentAgentRun, CurrentAgentStep, CurrentModelCallRecorder, ModelCallId, modelFailureOf, recordCompletion } from "@xandreed/core"
import type { ModelCallData, ModelCallMethod, ModelCallOutcome, ModelCallPurpose, ModelCallRecorder, ModelSelection, RunId, RunOrdinal, TurnError } from "@xandreed/core"
import { randomUuid } from "@xandreed/core/internal"
import { CurrentModelCallMethod, CurrentModelCallPurpose, CurrentModelCallSelection } from "../ports/model-call-completion.port.js"
import type { ProviderFailureProtocol } from "./provider-failure.entity.js"
import { ModelCompletionState } from "./model-completion.entity.js"
import { claimModelCompletion } from "./model-completion.entity.functions.js"
import { noProviderUsage, ProviderUsageBody } from "./model-usage.entity.js"
import type { ProviderUsageObservation } from "./model-usage.entity.js"
import { modelCallUsageOf, observeProviderUsage, providerUsageCounts } from "./model-usage.entity.functions.js"

export interface ModelCompletionCall {
  readonly callId: ModelCallId
  readonly attempts: Ref.Ref<ReadonlyArray<ModelAttempt>>
}
export interface ModelAttempt {
  readonly callId: ModelCallId
  readonly ordinal: number
  readonly startedAt: number
  readonly protocol: ProviderFailureProtocol
  readonly purpose: ModelCallPurpose
  readonly method: ModelCallMethod
  readonly model: Option.Option<ModelSelection>
  readonly runId: Option.Option<RunId>
  readonly run: Option.Option<RunOrdinal>
  readonly step: Option.Option<number>
  readonly recorder: ModelCallRecorder
  readonly usage: Ref.Ref<ProviderUsageObservation>
  readonly phase: Ref.Ref<ModelCompletionState>
  readonly ack: Deferred.Deferred<void, TurnError>
}
const attempts = new WeakMap<object, ModelAttempt>()

export const makeCompletionCall = Effect.fnUntraced(function* (): Effect.fn.Return<ModelCompletionCall> {
  return { callId: ModelCallId.make(yield* randomUuid), attempts: yield* Ref.make<ReadonlyArray<ModelAttempt>>([]) }
})
export const beginModelAttempt = Effect.fnUntraced(function* (call: ModelCompletionCall, ordinal: number, protocol: ProviderFailureProtocol): Effect.fn.Return<ModelAttempt> {
  const run = yield* CurrentAgentRun
  const attempt: ModelAttempt = {
    callId: call.callId, ordinal, protocol, startedAt: yield* Clock.currentTimeMillis,
    purpose: yield* CurrentModelCallPurpose, method: yield* CurrentModelCallMethod,
    model: yield* CurrentModelCallSelection, runId: Option.map(run, (value) => value.id), run: Option.map(run, (value) => value.ordinal),
    step: Option.isSome(run) ? yield* CurrentAgentStep : Option.none(), recorder: yield* CurrentModelCallRecorder,
    usage: yield* Ref.make(noProviderUsage), phase: yield* Ref.make<ModelCompletionState>({ _tag: "Open" }), ack: yield* Deferred.make<void, TurnError>(),
  }
  yield* Ref.update(call.attempts, (before) => [...before, attempt])
  return attempt
})
export const modelAttemptOf = (response: object): Option.Option<ModelAttempt> => Option.fromNullishOr(attempts.get(response))
export const retainModelAttempt = <A extends object>(source: object, target: A): A => {
  Option.match(modelAttemptOf(source), { onNone: () => undefined, onSome: (attempt) => attempts.set(target, attempt) })
  return target
}
export const attachModelAttempt = <A extends object>(attempt: ModelAttempt, response: A): A => { attempts.set(response, attempt); return response }

export const observeModelAttempt = (attempt: ModelAttempt, value: unknown, final: boolean, reasoning = true): Effect.Effect<void> => Option.match(providerUsageCounts(attempt.protocol, value, reasoning), {
  onNone: () => Effect.void,
  onSome: (counts) => Ref.update(attempt.usage, (before) => observeProviderUsage(before, counts, final)),
})

export const completeModelAttempt = Effect.fn("models.record_attempt")(function* (attempt: ModelAttempt, outcome: ModelCallOutcome): Effect.fn.Return<void, TurnError> {
  return yield* Effect.uninterruptible(Effect.gen(function* () {
    const claimed = yield* Ref.modify(attempt.phase, claimModelCompletion)
    if (!claimed) return yield* Deferred.await(attempt.ack)
    const data: ModelCallData = {
      callId: attempt.callId, attempt: attempt.ordinal, purpose: attempt.purpose, method: attempt.method, model: attempt.model,
      runId: attempt.runId, run: attempt.run, step: attempt.step, durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - attempt.startedAt),
      usage: modelCallUsageOf(attempt.protocol, yield* Ref.get(attempt.usage)), outcome,
    }
    const result = yield* Effect.exit(recordCompletion(data).pipe(Effect.provideService(CurrentModelCallRecorder, attempt.recorder)))
    const phase: ModelCompletionState = Exit.isSuccess(result) ? { _tag: "Recorded" } : { _tag: "RecordFailed" }
    yield* Ref.set(attempt.phase, phase)
    yield* Deferred.done(attempt.ack, result)
    return yield* Exit.match(result, { onSuccess: () => Effect.void, onFailure: Effect.failCause })
  }))
})

export const modelOutcomeOfExit = <A, E>(exit: Exit.Exit<A, E>): ModelCallOutcome => Exit.match(exit, {
  onSuccess: () => ({ _tag: "Completed" }),
  onFailure: (cause) => Cause.hasInterrupts(cause) ? { _tag: "Interrupted" } : { _tag: "Failed", failure: modelFailureOf(Cause.squash(cause)) },
})

/** Provider/SDK cleanup settles only attempts that no raw boundary has already claimed. */
export const completePendingAttempts = Effect.fnUntraced(function* <A, E>(call: ModelCompletionCall, exit: Exit.Exit<A, E>): Effect.fn.Return<void, TurnError> {
  yield* Effect.forEach(yield* Ref.get(call.attempts), (attempt) => Effect.flatMap(Ref.get(attempt.phase), (state) => ModelCompletionState.match(state, { Open: () => completeModelAttempt(attempt, modelOutcomeOfExit(exit)), Recorded: () => Effect.void, Recording: () => Deferred.await(attempt.ack), RecordFailed: () => Deferred.await(attempt.ack) })), { concurrency: 1, discard: true })
})

export const observeResponseUsage = (response: object, value: unknown, final: boolean, reasoning = true): Effect.Effect<void> => Option.match(modelAttemptOf(response), {
  onNone: () => Effect.void, onSome: (attempt) => observeModelAttempt(attempt, value, final, reasoning),
})
export const completeResponseAttempt = (response: object, outcome: ModelCallOutcome): Effect.Effect<void, TurnError> => Option.match(modelAttemptOf(response), {
  onNone: () => Effect.void, onSome: (attempt) => completeModelAttempt(attempt, outcome),
})

/** The fixed native SDK client surface has AiError only; retain the original recorder failure as a defect. */
export const completeSdkResponseAttempt = (response: object, outcome: ModelCallOutcome): Effect.Effect<void> => completeResponseAttempt(response, outcome).pipe(Effect.catch((error) => Effect.die(error)))

/** Rejected/compat JSON can report usage even when no SDK completion is accepted. */
export const observeModelBody = (attempt: ModelAttempt, body: string, final: boolean, reasoning = true): Effect.Effect<void> => Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(ProviderUsageBody))(body), {
  onNone: () => Effect.void, onSome: (value) => observeModelAttempt(attempt, value.usage, final, reasoning),
})
