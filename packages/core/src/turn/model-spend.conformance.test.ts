import { expect, test } from "bun:test"
import { Effect, Match, Option, Ref } from "effect"
import { ModelSpendUnavailable, SpendHoldId } from "../domain/model-spend.entity.js"
import type { SpendHold, SpendLedger } from "../domain/model-spend.entity.js"
import { emptySpendLedger, forgetSpend, releaseSpend, reserveSpend, settleSpend, spendTotalsOf } from "../domain/model-spend.entity.functions.js"
import { ModelSpend } from "../ports/model-spend.port.js"
import { modelSpendConformance } from "./model-spend.conformance.js"
import type { ModelSpendSubject } from "./model-spend.conformance.js"
import { ModelSpendMemoryLive } from "./model-spend.memory.adapter.js"

const ids = ["reserve", "turn-cap", "total-cap", "settle", "release", "repeat", "concurrent", "forget", "uncapped"]

const failedChecks = (subject: ModelSpendSubject) => Effect.runPromise(Effect.forEach(modelSpendConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 },
).pipe(Effect.map((checks) => checks.flat())))

const unavailable = () => Effect.fail(new ModelSpendUnavailable({ message: "ledger unreachable" }))

type Fault = "no-op" | "racy" | "settles-twice" | "no-turn-cap" | "release-settles" | "refusal-holds" | "never-forgets" | "forgets-at-once"

/** A ledger with one mistake, over the real transitions otherwise. */
const careless = (fault: Fault): ModelSpendSubject => ({
  open: () => Effect.gen(function* () {
    const state = yield* Ref.make<SpendLedger>(emptySpendLedger)
    const count = yield* Ref.make(0)
    const nextId = Ref.updateAndGet(count, (n) => n + 1).pipe(Effect.map((n) => SpendHoldId.make(`hold-${n}`)))
    return ModelSpend.of({
      reserve: (request) => Effect.gen(function* () {
        const id = yield* nextId
        const hold: SpendHold = { id, runId: Option.fromNullishOr(request.runId), amount: request.amount }
        if (fault === "no-op") return hold
        const before = yield* Ref.get(state)
        if (fault === "racy") yield* Effect.yieldNow
        const decided = reserveSpend(before, fault === "no-turn-cap" ? { ...request, caps: { ...(request.caps.total === undefined ? {} : { total: request.caps.total }) } } : request, id)
        if (decided._tag === "Failure") {
          if (fault === "refusal-holds") yield* Ref.set(state, { ...before, holds: [...before.holds, hold] })
          return yield* Effect.fail(decided.failure)
        }
        yield* Ref.set(state, decided.success[1])
        return decided.success[0]
      }),
      settle: (hold, cost) => Ref.update(state, (ledger) => fault === "settles-twice" && !ledger.holds.some((open) => open.id === hold.id)
        ? { ...ledger, settled: ledger.settled + cost, settledByRun: Option.match(hold.runId, { onNone: () => ledger.settledByRun, onSome: (run) => ({ ...ledger.settledByRun, [run]: (ledger.settledByRun[run] ?? 0) + cost }) }) }
        : settleSpend(ledger, hold.id, cost)),
      release: (hold) => Ref.update(state, (ledger) => fault === "release-settles" ? settleSpend(ledger, hold.id, hold.amount) : releaseSpend(ledger, hold.id)),
      forget: (runId) => Ref.update(state, (ledger) => Match.value(fault).pipe(
        Match.when("never-forgets", () => ledger),
        Match.when("forgets-at-once", () => ({ ...ledger, settledByRun: Object.fromEntries(Object.entries(ledger.settledByRun).filter(([run]) => run !== runId)), holds: ledger.holds.filter((hold) => !Option.contains(hold.runId, runId)) })),
        Match.orElse(() => forgetSpend(ledger, runId)),
      )),
      totals: (runId) => Effect.map(Ref.get(state), (ledger) => spendTotalsOf(ledger, runId)),
    })
  }),
})

test("the ModelSpend kit lists its nine promises, each failed by a ledger that cannot be reached", async () => {
  expect(modelSpendConformance({ open: unavailable }).map((check) => check.name)).toHaveLength(9)
  expect(await failedChecks({ open: () => Effect.succeed(ModelSpend.of({ reserve: unavailable, settle: unavailable, release: unavailable, forget: unavailable, totals: unavailable })) })).toEqual(ids)
})

test.each([
  { fault: "no-op" as const, checks: ["reserve", "turn-cap", "total-cap", "settle", "concurrent", "forget"] },
  { fault: "racy" as const, checks: ["concurrent"] },
  { fault: "settles-twice" as const, checks: ["repeat"] },
  { fault: "no-turn-cap" as const, checks: ["turn-cap", "concurrent"] },
  { fault: "release-settles" as const, checks: ["release"] },
  { fault: "refusal-holds" as const, checks: ["turn-cap", "total-cap"] },
  { fault: "never-forgets" as const, checks: ["forget"] },
  { fault: "forgets-at-once" as const, checks: ["forget"] },
])("the kit catches a ledger that is $fault", async ({ fault, checks }) => {
  const failed = await failedChecks(careless(fault))
  checks.forEach((check) => expect(failed).toContain(check))
})

test.each([...modelSpendConformance({ open: () => Effect.service(ModelSpend).pipe(Effect.provide(ModelSpendMemoryLive)) })])("memory: $name", async (check) => {
  await Effect.runPromise(check.run)
})
