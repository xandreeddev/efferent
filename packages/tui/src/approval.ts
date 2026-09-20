import { Deferred, Effect, PubSub, Stream } from "effect"
import type { HarnessError } from "@xandreed/core"

export interface ApprovalNotice { readonly id: string; readonly description: string; readonly answer: (allowed: boolean) => Effect.Effect<void>; readonly cancelled: boolean }
export const makeApprovalChannel = Effect.gen(function* () {
  const hub = yield* PubSub.unbounded<ApprovalNotice>()
  const gate = yield* Effect.makeSemaphore(1)
  return {
    events: Stream.fromPubSub(hub),
    request: (description: string): Effect.Effect<boolean, HarnessError> => gate.withPermits(1)(Effect.gen(function* () {
      const result = yield* Deferred.make<boolean>()
      const request = { id: crypto.randomUUID(), description, answer: (allowed: boolean) => Deferred.succeed(result, allowed).pipe(Effect.asVoid), cancelled: false }
      yield* PubSub.publish(hub, request)
      return yield* Deferred.await(result).pipe(Effect.ensuring(PubSub.publish(hub, { ...request, cancelled: true })))
    })),
  }
})
export type ApprovalChannel = Effect.Effect.Success<typeof makeApprovalChannel>
