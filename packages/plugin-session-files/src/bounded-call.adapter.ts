import { Cause, Clock, Deferred, Effect, Exit, Option, Ref, Result, Semaphore } from "effect"
import { FileStoreIo, FileStoreStalled } from "./session-files.entity.js"
import type { StoreHealth } from "./session-files.entity.js"
import { abandonCall, admitCall, afterCall } from "./session-files.entity.functions.js"

type Failed = FileStoreIo | FileStoreStalled
const withinDeadline = <A>(promise: Promise<A>, ms: number, stalled: FileStoreStalled): Promise<A> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(stalled), ms)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})

/** Two native operations per handle; timed-out callers retain their physical slots until settlement. */
export const makeBoundedFilesCall = Effect.fnUntraced(function* (stallMs: number) {
  const logical = yield* Semaphore.make(2)
  const health = yield* Ref.make<StoreHealth>({ _tag: "Healthy" })
  const pending = new Set<object>()
  const settle = (answered: boolean) => Clock.currentTimeMillis.pipe(Effect.flatMap(now => Ref.update(health, current => afterCall(current, answered, now))))
  return <A>(op: string, path: string, run: () => Promise<A>): Effect.Effect<A, Failed> => Effect.gen(function* () {
    const stalled = new FileStoreStalled({ op, path, ms: stallMs })
    const now = yield* Clock.currentTimeMillis
    if (!admitCall(yield* Ref.get(health), now, stallMs)[0]) return yield* Effect.fail(stalled)
    const admission = yield* Deferred.make<void, Failed>()
    const execute = Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      const token = yield* Effect.sync(() => {
        if (pending.size >= 2) return Option.none<object>()
        const token = {}
        pending.add(token)
        return Option.some(token)
      })
      if (Option.isNone(token)) return yield* Effect.fail(stalled)
      const claimed = yield* Clock.currentTimeMillis.pipe(Effect.flatMap(at => Ref.modify(health, current => {
        const [allowed, next] = admitCall(current, at, stallMs)
        return [{ allowed, probe: allowed && current._tag === "Stalled" ? Option.some(next) : Option.none<StoreHealth>() }, next] as const
      })))
      if (!claimed.allowed) {
        yield* Effect.sync(() => pending.delete(token.value))
        return yield* Effect.fail(stalled)
      }
      // Converts synchronous run() throws and eventual rejections to fulfilled
      // outcomes before restore can observe interruption; finally alone on a
      // rejected Promise could otherwise leave an unobserved rejection.
      const outcome = yield* Effect.sync(() => Promise.resolve().then(run).then(
        (value): Result.Result<A, unknown> => Result.succeed(value),
        (cause): Result.Result<A, unknown> => Result.fail(cause),
      ).finally(() => { pending.delete(token.value) }))
      return yield* restore(Effect.tryPromise({
        try: () => withinDeadline(outcome, stallMs, stalled),
        catch: (cause): Failed => cause === stalled ? stalled : new FileStoreIo({ op, path, cause }),
      }).pipe(Effect.flatMap(Result.match({
        onSuccess: Effect.succeed,
        onFailure: cause => Effect.fail(new FileStoreIo({ op, path, cause })),
      })))).pipe(Effect.onExit(exit => {
        if (Exit.isSuccess(exit)) return settle(true)
        const failed = exit.cause.reasons.find(Cause.isFailReason)
        return failed === undefined ? Option.match(claimed.probe, {
          onNone: () => Effect.void,
          onSome: probe => Ref.update(health, current => abandonCall(current, probe)),
        }) : settle(failed.error._tag === "FileStoreIo")
      }))
    }))
    // The semaphore owns acquisition/release even when its queued fiber loses
    // the deadline race. The latch prevents a late grant from starting IO.
    return yield* Effect.uninterruptibleMask(restore => restore(Effect.raceFirst(
      logical.withPermits(1)(Effect.gen(function* () {
        if (!(yield* Deferred.succeed(admission, undefined))) return yield* Effect.fail(stalled)
        return yield* restore(execute)
      })).pipe(Effect.interruptible),
      Effect.sleep(stallMs).pipe(
        Effect.andThen(Deferred.fail(admission, stalled)),
        Effect.flatMap(expired => expired ? Effect.fail(stalled) : Effect.never),
        Effect.interruptible,
      ),
    )))
  })
})
