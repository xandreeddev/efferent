import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import {
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

  test("usage drains the pool by billed tokens (input + output)", async () => {
    await run(
      Effect.gen(function* () {
        const pool = yield* makeTokenPool(1000)
        yield* drainPool(pool, { inputTokens: 600, outputTokens: 150, cacheReadTokens: 500 })
        expect(yield* Ref.get(pool!)).toBe(250)
        // cacheReadTokens are informational, not billed twice
        expect(usageCost({ inputTokens: 600, outputTokens: 150, cacheReadTokens: 500 })).toBe(750)
      }),
    )
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
