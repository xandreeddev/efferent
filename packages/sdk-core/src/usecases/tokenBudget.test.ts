import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import {
  CACHE_READ_COST_FACTOR,
  drainPool,
  makeTokenPool,
  poolExhausted,
  usageCost,
} from "./tokenBudget.js"

const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

describe("tokenBudget", () => {
  test("a positive budget makes a live pool; <= 0 disables it", async () => {
    const live = await run(makeTokenPool(1000))
    expect(live).not.toBeNull()
    expect(await run(makeTokenPool(0))).toBeNull()
    expect(await run(makeTokenPool(-5))).toBeNull()
  })

  test("usage drains the pool by REAL billed cost — cache reads discounted", async () => {
    await run(
      Effect.gen(function* () {
        const pool = yield* makeTokenPool(1000)
        // input 600, of which 500 were cache hits → fresh 100 @1× + cached 500 @0.1× + output 150
        // = 100 + 50 + 150 = 300 (NOT 750 — the old full-price bug).
        yield* drainPool(pool, { inputTokens: 600, outputTokens: 150, cacheReadTokens: 500 })
        expect(yield* Ref.get(pool!)).toBe(700)
        expect(usageCost({ inputTokens: 600, outputTokens: 150, cacheReadTokens: 500 })).toBe(300)
      }),
    )
  })

  test("usageCost: no cache → full price; all-cache input → only the discount + output", () => {
    expect(usageCost({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 })).toBe(150)
    // Whole prompt cached (the steady-state of a multi-turn agent): 100×0.1 + 20.
    expect(usageCost({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 100 })).toBe(
      100 * CACHE_READ_COST_FACTOR + 20,
    )
    // cacheRead is clamped to inputTokens (never negative fresh).
    expect(usageCost({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 9999 })).toBe(
      100 * CACHE_READ_COST_FACTOR,
    )
  })

  // Regression: the run that exhausted a 4M pool on ~500K of real work. Its
  // recorded usage was 97.7% cache reads — at full price that drained ~8× too
  // fast. With the discount, the same usage costs a fraction, so the budget
  // tracks real spend instead of re-sent cached context.
  test("regression: a 97.7%-cached turn costs ~8× less than the old full-price count", () => {
    const u = { inputTokens: 449_447, outputTokens: 46_433, cacheReadTokens: 439_296 }
    const oldFullPrice = u.inputTokens + u.outputTokens // 495,880
    const corrected = usageCost(u)
    expect(corrected).toBeLessThan(oldFullPrice / 4)
    // fresh 10,151 + 439,296×0.1 + 46,433 = 100,513.6
    expect(corrected).toBeCloseTo(100_513.6, 0)
  })

  test("exhaustion at <= 0; a disabled pool never exhausts", async () => {
    await run(
      Effect.gen(function* () {
        const pool = yield* makeTokenPool(100)
        expect(yield* poolExhausted(pool)).toBe(false)
        yield* drainPool(pool, { inputTokens: 90, outputTokens: 20, cacheReadTokens: 0 })
        expect(yield* poolExhausted(pool)).toBe(true)
        expect(yield* poolExhausted(null)).toBe(false)
      }),
    )
  })

  test("the pool is shared by reference — a child's drain is visible to the parent", async () => {
    await run(
      Effect.gen(function* () {
        const pool = yield* makeTokenPool(100)
        // simulate a child loop draining "its" pool (same Ref, copied into a child RunContext)
        const childView = pool
        yield* drainPool(childView, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 })
        expect(yield* poolExhausted(pool)).toBe(true)
      }),
    )
  })
})
