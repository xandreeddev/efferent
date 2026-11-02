import { Cause, Clock, Deferred, Effect, Exit, Option, Ref, Result, Semaphore } from "effect"
import { FileStoreIo, FileStoreStalled } from "./session-files.entity.js"
import type { StoreHealth } from "./session-files.entity.js"
import { abandonCall, admitCall, afterCall } from "./session-files.entity.functions.js"

type Failed = FileStoreIo | FileStoreStalled
const withinDeadline = <A>(promise: Promise<A>, ms: number, stalled: FileStoreStalled): Promise<A> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(stalled), ms)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})

/** The native operations a handle has in flight at most. */
const NATIVE_SLOTS = 2

/**
 * Two native operations per handle. A call holds a slot from its admission
 * until its native operation settles: one whose caller stopped waiting (a
 * timeout, an interrupt) keeps its slot until it settles, the handle's
 * capacity lowered by one meanwhile. While healthy, a call queues for a free
 * slot within the admission deadline, so a hung operation slows the others
 * and never fails them; a cooldown probe never waits (a full slot set fails
 * it at once).
 */
export const makeBoundedFilesCall = Effect.fnUntraced(function* (stallMs: number) {
  const slots = yield* Semaphore.make(NATIVE_SLOTS)
  const health = yield* Ref.make<StoreHealth>({ _tag: "Healthy" })
  /** The native operations whose caller left before they settled: each holds a slot of the capacity. */
  const orphans = { count: 0 }
  const capacity = (change: number) => Effect.suspend(() => {
    orphans.count += change
    return slots.resize(NATIVE_SLOTS - orphans.count)
  })
  const settle = (answered: boolean) => Clock.currentTimeMillis.pipe(Effect.flatMap(now => Ref.update(health, current => afterCall(current, answered, now))))
  return <A>(op: string, path: string, run: () => Promise<A>): Effect.Effect<A, Failed> => Effect.gen(function* () {
    const stalled = new FileStoreStalled({ op, path, ms: stallMs })
    const now = yield* Clock.currentTimeMillis
    const before = yield* Ref.get(health)
    if (!admitCall(before, now, stallMs)[0]) return yield* Effect.fail(stalled)
    const admission = yield* Deferred.make<void, Failed>()
    // Runs holding a slot: claims the health (a probe, while stalled), starts the native operation and waits for it
    // within `stallMs`. The slot is released when this ends, unless the native operation still runs: the capacity then
    // stays lowered until it settles.
    const execute = Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      const claimed = yield* Clock.currentTimeMillis.pipe(Effect.flatMap(at => Ref.modify(health, current => {
        const [allowed, next] = admitCall(current, at, stallMs)
        return [{ allowed, probe: allowed && current._tag === "Stalled" ? Option.some(next) : Option.none<StoreHealth>() }, next] as const
      })))
      if (!claimed.allowed) return yield* Effect.fail(stalled)
      const native = { settled: false, orphaned: false }
      // Converts synchronous run() throws and eventual rejections to fulfilled
      // outcomes before restore can observe interruption; finally alone on a
      // rejected Promise could otherwise leave an unobserved rejection.
      const outcome = yield* Effect.sync(() => Promise.resolve().then(run).then(
        (value): Result.Result<A, unknown> => Result.succeed(value),
        (cause): Result.Result<A, unknown> => Result.fail(cause),
      ).finally(() => {
        native.settled = true
        if (native.orphaned) Effect.runSync(capacity(-1))
      }))
      // A caller that leaves before its native operation settled hands its slot over to that operation.
      const handOver = Effect.suspend(() => {
        if (native.settled) return Effect.void
        native.orphaned = true
        return capacity(1)
      })
      return yield* restore(Effect.tryPromise({
        try: () => withinDeadline(outcome, stallMs, stalled),
        catch: (cause): Failed => cause === stalled ? stalled : new FileStoreIo({ op, path, cause }),
      }).pipe(Effect.flatMap(Result.match({
        onSuccess: Effect.succeed,
        onFailure: cause => Effect.fail(new FileStoreIo({ op, path, cause })),
      })))).pipe(Effect.onExit(exit => handOver.pipe(Effect.andThen(() => {
        if (Exit.isSuccess(exit)) return settle(true)
        const failed = exit.cause.reasons.find(Cause.isFailReason)
        return failed === undefined ? Option.match(claimed.probe, {
          onNone: () => Effect.void,
          onSome: probe => Ref.update(health, current => abandonCall(current, probe)),
        }) : settle(failed.error._tag === "FileStoreIo")
      }))))
    }))
    // A cooldown probe takes a free slot or fails at once: slots held by hung operations block it.
    if (before._tag === "Stalled") {
      return yield* slots.withPermitsIfAvailable(1)(execute).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.fail(stalled),
        onSome: Effect.succeed,
      })))
    }
    // A healthy call queues for a slot within the admission deadline. The semaphore owns acquisition and release even
    // when its queued fiber loses the deadline race; the latch keeps a late grant from starting IO.
    return yield* Effect.uninterruptibleMask(restore => restore(Effect.raceFirst(
      slots.withPermits(1)(Effect.gen(function* () {
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
