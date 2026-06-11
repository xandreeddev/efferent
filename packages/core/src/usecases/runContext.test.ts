import { describe, expect, it } from "bun:test"
import { Effect, Fiber, FiberRef, Ref } from "effect"
import { initialRunContext, RunContextRef, type RunContext } from "./runContext.js"
import { drainPool, makeTokenPool, poolExhausted } from "./tokenBudget.js"

describe("RunContextRef", () => {
  it("reads the initial context when nothing has seeded it", async () => {
    const ctx = await Effect.runPromise(FiberRef.get(RunContextRef))
    expect(ctx).toEqual(initialRunContext)
    expect(ctx.depth).toBe(0)
    expect(ctx.rootConversationId).toBeNull()
    expect(ctx.parentNodeId).toBeNull()
    expect(ctx.tokenPool).toBeNull()
  })

  it("Effect.locally scopes an override: visible inside, restored outside", async () => {
    const seeded: RunContext = { ...initialRunContext, depth: 1, subAgentMaxSteps: 7 }
    const program = Effect.gen(function* () {
      const inside = yield* FiberRef.get(RunContextRef).pipe(
        Effect.locally(RunContextRef, seeded),
      )
      const outside = yield* FiberRef.get(RunContextRef)
      return { inside, outside }
    })
    const { inside, outside } = await Effect.runPromise(program)
    expect(inside).toEqual(seeded)
    expect(outside).toEqual(initialRunContext)
  })

  it("a forked fiber inherits the seeding fiber's context — how spawns read their parent", async () => {
    const seeded: RunContext = { ...initialRunContext, depth: 2 }
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(FiberRef.get(RunContextRef))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.locally(RunContextRef, seeded))
    expect(await Effect.runPromise(program)).toEqual(seeded)
  })

  it("re-seeding for a child copies the SAME pool reference — grandchild spend drains the root's gate", async () => {
    const program = Effect.gen(function* () {
      const pool = yield* makeTokenPool(1000)
      const root: RunContext = { ...initialRunContext, tokenPool: pool }

      // Spawn re-seed: depth+1, same pool reference (what buildScopeRuntime does).
      const childWork = Effect.gen(function* () {
        const ctx = yield* FiberRef.get(RunContextRef)
        const grandchild: RunContext = { ...ctx, depth: ctx.depth + 1 }
        yield* drainPool(grandchild.tokenPool, {
          inputTokens: 300,
          outputTokens: 200,
          cacheReadTokens: 50, // cache reads are free — never billed to the pool
        }).pipe(Effect.locally(RunContextRef, grandchild))
        return grandchild.depth
      })

      const depth = yield* childWork.pipe(Effect.locally(RunContextRef, root))
      const remaining = yield* Ref.get(pool!)
      const exhausted = yield* poolExhausted(pool)
      return { depth, remaining, exhausted }
    })
    const { depth, remaining, exhausted } = await Effect.runPromise(program)
    expect(depth).toBe(1)
    expect(remaining).toBe(500) // 1000 - (300 input + 200 output); cacheRead free
    expect(exhausted).toBe(false)
  })

  it("draining past zero exhausts the pool for every holder of the reference", async () => {
    const program = Effect.gen(function* () {
      const pool = yield* makeTokenPool(100)
      yield* drainPool(pool, { inputTokens: 80, outputTokens: 40, cacheReadTokens: 0 })
      return yield* poolExhausted(pool)
    })
    expect(await Effect.runPromise(program)).toBe(true)
  })
})
