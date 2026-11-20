import { Clock, Deferred, Duration, Effect, Match, Option, Predicate, Ref, Result } from "effect"
import type { Context } from "effect"
import { ModelSpend, ModelSpendExceeded } from "@xandreed/core"
import type { ModelSpendUnavailable, SpendHold, SpendHoldId, SpendRequest } from "@xandreed/core"
import { STAGE_WAIT_MS } from "./stage-spend.entity.js"
import type { StageLedger } from "./stage-spend.port.js"
import { stageStep } from "./stage-spend.entity.functions.js"

type Ledger = Context.Service.Shape<typeof ModelSpend>

/** A stage's ledger as it stands: settled; what its calls hold and how many are open (held or being claimed); what it keeps back; each hold's amount and whether it is kept back; the signal its next close gives. */
interface StageState {
  readonly settled: number
  readonly calls: number
  readonly open: number
  readonly kept: number
  /** Keeps the parent has not answered yet: their amounts are in `kept`, their holds not yet in `holds`. */
  readonly keeping: number
  readonly holds: ReadonlyMap<SpendHoldId, { readonly amount: number; readonly kept: boolean }>
  readonly closed: Deferred.Deferred<void>
}

/** What a stage's ledger is asked: how long a call waits, in all, for an open call to close before it is refused. */
export interface StageSpendOptions {
  readonly waitMs?: number
}

/** Whether a ledger is a stage's, which keeps back without waiting. */
const isStage = (ledger: Ledger | StageLedger): ledger is StageLedger => Predicate.hasProperty(ledger, "keepBack") && Predicate.isFunction(ledger.keepBack)

/** What the stage holds, its calls' and what it keeps back. */
const heldOf = (state: StageState): number => state.calls + state.kept

/**
 * A ledger for one stage of a review (or one pass of it) inside `parent`: every reservation is also the parent's, and
 * the stage keeps its own totals under its own `cap` (none: no cap of its own, for a pass's exact cost). A reservation
 * that what the stage settled leaves no room for is refused (`ModelSpendExceeded`, its reason `total`, the stage's
 * cap); one that the stage's open calls crowd out waits, interruptibly and holding nothing, until one closes
 * (`stageStep`, which counts open calls, never a sum of amounts), so parallel calls under a tight cap run one after
 * another instead of failing; one that only what is kept back crowds out is refused, since nothing will close; past
 * `waitMs` (`STAGE_WAIT_MS`) of waiting in all it is refused, saying so. A hold is closed in the stage whether or not
 * the parent closes it (a parent that fails to settle never leaks the stage's hold); closing it again changes
 * nothing; when the last open call closes, what the calls hold is 0, whatever floating point left. `keepBack` holds
 * an amount only when it fits now, in the parent's `keepBack` when it has one.
 */
export const stageSpend = Effect.fn("review.stage_spend")(function* (parent: Ledger | StageLedger, cap: Option.Option<number>, options: StageSpendOptions = {}) {
  const state = yield* Ref.make<StageState>({ settled: 0, calls: 0, open: 0, kept: 0, keeping: 0, holds: new Map(), closed: yield* Deferred.make<void>() })
  const waitMs = options.waitMs ?? STAGE_WAIT_MS
  const limit = Option.getOrElse(cap, () => 0)

  /** Change the totals and wake whoever waits for a close; with no call open, the calls hold nothing, and with nothing kept back, nothing is kept. */
  const closeWith = (change: (current: StageState) => Omit<StageState, "closed">) => Effect.gen(function* () {
    const next = yield* Deferred.make<void>()
    const woken = yield* Ref.modify(state, (current) => {
      const changed = change(current)
      const keptHolds = changed.keeping > 0 || [...changed.holds.values()].some((hold) => hold.kept)
      return [current.closed, { ...changed, calls: changed.open === 0 ? 0 : Math.max(0, changed.calls), kept: keptHolds ? Math.max(0, changed.kept) : 0, closed: next }]
    })
    yield* Deferred.succeed(woken, undefined)
  })

  const unclaim = (amount: number) => closeWith((current) => ({ ...current, calls: current.calls - amount, open: current.open - 1 }))

  const refused = (committed: number, requested: number, why: string) => new ModelSpendExceeded({ reason: "total", cap: limit, committed, requested, message: `the stage's model spend cap of ${limit} ${why}` })

  const claim = (request: SpendRequest, deadline: Option.Option<number>): Effect.Effect<SpendHold, ModelSpendExceeded | ModelSpendUnavailable> => Effect.gen(function* () {
    const [step, closed, committed] = yield* Ref.modify(state, (current) => {
      const decided = stageStep({ settled: current.settled, reserved: heldOf(current), open: current.open }, request.amount, cap)
      const claimed = decided._tag === "Claim" ? { ...current, calls: current.calls + request.amount, open: current.open + 1 } : current
      return [[decided, current.closed, current.settled + heldOf(current)] as const, claimed]
    })
    return yield* Match.valueTags(step, {
      Refuse: () => Effect.fail(refused(committed, request.amount, `would be passed: ${committed} is settled or held, ${request.amount} more was asked for`)),
      // Nothing is held while it waits, so the wait may be interrupted even inside the caller's uninterruptible reserve.
      Wait: () => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const until = Option.getOrElse(deadline, () => now + waitMs)
        const woken = yield* Effect.interruptible(Deferred.await(closed)).pipe(Effect.timeoutOption(Duration.millis(Math.max(0, until - now))))
        return yield* Option.match(woken, {
          onNone: () => Effect.fail(refused(committed, request.amount, `was full for ${waitMs} ms of waiting: ${committed} is settled or held, ${request.amount} more was asked for`)),
          onSome: () => claim(request, Option.some(until)),
        })
      }),
      Claim: () => parent.reserve(request).pipe(
        Effect.onError(() => unclaim(request.amount)),
        Effect.tap((hold) => Ref.update(state, (current) => ({ ...current, holds: new Map([...current.holds, [hold.id, { amount: request.amount, kept: false }]]) }))),
      ),
    })
  })

  /** Close a hold in the stage: what it held freed, `cost` settled; a hold the stage does not hold changes nothing. */
  const close = (hold: SpendHold, cost: number) => closeWith((current) => {
    const held = current.holds.get(hold.id)
    if (held === undefined) return current
    const holds = new Map(current.holds)
    holds.delete(hold.id)
    return held.kept
      ? { ...current, settled: current.settled + cost, kept: current.kept - held.amount, holds }
      : { ...current, settled: current.settled + cost, calls: current.calls - held.amount, open: current.open - 1, holds }
  })

  /** The parent's hold for what is kept back: its own `keepBack` when it has one, else a reservation it refuses rather than waits on. */
  const parentKeeps = (amount: number): Effect.Effect<Option.Option<SpendHold>> =>
    isStage(parent) ? parent.keepBack(amount) : Effect.map(Effect.result(parent.reserve({ amount, caps: {} })), Result.getSuccess)

  const keepBack = (amount: number): Effect.Effect<Option.Option<SpendHold>> => Effect.gen(function* () {
    const fits = yield* Ref.modify(state, (current) => {
      const room = Option.match(cap, { onNone: () => true, onSome: (most) => current.settled + heldOf(current) + amount <= most })
      return [room, room ? { ...current, kept: current.kept + amount, keeping: current.keeping + 1 } : current]
    })
    if (!fits) return Option.none()
    const held = yield* parentKeeps(amount)
    yield* Option.match(held, {
      onNone: () => closeWith((current) => ({ ...current, kept: current.kept - amount, keeping: current.keeping - 1 })),
      onSome: (hold) => Ref.update(state, (current) => ({ ...current, keeping: current.keeping - 1, holds: new Map([...current.holds, [hold.id, { amount, kept: true }]]) })),
    })
    return held
  })

  const ledger: StageLedger = {
    ...ModelSpend.of({
      reserve: (request) => claim(request, Option.none()),
      settle: (hold, cost) => parent.settle(hold, cost).pipe(Effect.ensuring(close(hold, cost))),
      release: (hold) => parent.release(hold).pipe(Effect.ensuring(close(hold, 0))),
      totals: Effect.map(Ref.get(state), (current) => ({ settled: current.settled, reserved: heldOf(current) })),
    }),
    keepBack,
  }
  return ledger
})
