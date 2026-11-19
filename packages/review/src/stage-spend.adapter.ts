import { Deferred, Effect, Match, Option, Ref } from "effect"
import type { Context } from "effect"
import { ModelSpend, ModelSpendExceeded } from "@xandreed/core"
import type { ModelSpendUnavailable, SpendHold, SpendHoldId, SpendRequest } from "@xandreed/core"
import { stageStep } from "./stage-spend.entity.functions.js"

type Ledger = Context.Service.Shape<typeof ModelSpend>

/** A stage's ledger as it stands: settled, held, the amount of each of its open holds, and the signal its next close gives. */
interface StageState {
  readonly settled: number
  readonly reserved: number
  readonly holds: ReadonlyMap<SpendHoldId, number>
  readonly closed: Deferred.Deferred<void>
}

/**
 * A ledger for one stage of a review (or one pass of it) inside `parent`: every reservation is also the parent's, and
 * the stage keeps its own totals under its own `cap` (none: no cap of its own, for a pass's exact cost). A reservation
 * that what the stage settled leaves no room for is refused (`ModelSpendExceeded`, its reason `total`, the stage's
 * cap); one that only the stage's open holds crowd out waits, interruptibly and holding nothing, until one closes
 * (`stageStep`), so parallel calls under a tight cap run one after another instead of failing. A hold is closed in the
 * parent first, then in the stage; closing it again changes nothing.
 */
export const stageSpend = Effect.fn("review.stage_spend")(function* (parent: Ledger, cap: Option.Option<number>) {
  const state = yield* Ref.make<StageState>({ settled: 0, reserved: 0, holds: new Map(), closed: yield* Deferred.make<void>() })

  /** Change the totals and wake whoever waits for a close. */
  const closeWith = (change: (current: StageState) => Omit<StageState, "closed">) => Effect.gen(function* () {
    const next = yield* Deferred.make<void>()
    const woken = yield* Ref.modify(state, (current) => [current.closed, { ...change(current), closed: next }])
    yield* Deferred.succeed(woken, undefined)
  })

  const unclaim = (amount: number) => closeWith((current) => ({ ...current, reserved: Math.max(0, current.reserved - amount) }))

  const claim = (request: SpendRequest): Effect.Effect<SpendHold, ModelSpendExceeded | ModelSpendUnavailable> => Effect.gen(function* () {
    const [step, closed, committed] = yield* Ref.modify(state, (current) => {
      const decided = stageStep(current, request.amount, cap)
      const claimed = decided._tag === "Claim" ? { ...current, reserved: current.reserved + request.amount } : current
      return [[decided, current.closed, current.settled + current.reserved] as const, claimed]
    })
    const limit = Option.getOrElse(cap, () => 0)
    return yield* Match.valueTags(step, {
      Refuse: () => Effect.fail(new ModelSpendExceeded({
        reason: "total",
        cap: limit,
        committed,
        requested: request.amount,
        message: `the stage's model spend cap of ${limit} would be passed: ${committed} is settled or held, ${request.amount} more was asked for`,
      })),
      // Nothing is held while it waits, so the wait may be interrupted even inside the caller's uninterruptible reserve.
      Wait: () => Effect.andThen(Effect.interruptible(Deferred.await(closed)), Effect.suspend(() => claim(request))),
      Claim: () => parent.reserve(request).pipe(
        Effect.onError(() => unclaim(request.amount)),
        Effect.tap((hold) => Ref.update(state, (current) => ({ ...current, holds: new Map([...current.holds, [hold.id, request.amount]]) }))),
      ),
    })
  })

  /** Close a hold in the stage: what it held freed, `cost` settled; a hold the stage does not hold changes nothing. */
  const close = (hold: SpendHold, cost: number) => closeWith((current) => {
    const held = current.holds.get(hold.id)
    if (held === undefined) return current
    const holds = new Map(current.holds)
    holds.delete(hold.id)
    return { settled: current.settled + cost, reserved: Math.max(0, current.reserved - held), holds }
  })

  return ModelSpend.of({
    reserve: claim,
    settle: (hold, cost) => Effect.andThen(parent.settle(hold, cost), close(hold, cost)),
    release: (hold) => Effect.andThen(parent.release(hold), close(hold, 0)),
    totals: Effect.map(Ref.get(state), (current) => ({ settled: current.settled, reserved: current.reserved })),
  })
})
