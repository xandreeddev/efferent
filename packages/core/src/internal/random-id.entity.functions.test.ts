import { describe, expect, test } from "bun:test"
import { Effect, Random, Schema } from "effect"
import { randomUuid } from "./random-id.entity.functions.js"

describe("randomUuid", () => {
  test("is a version-4 UUID drawn from Random, so a seed repeats it", () => {
    const seeded = (seed: string) => Effect.runSync(Effect.all([randomUuid, randomUuid]).pipe(Random.withSeed(seed)))
    const [first, second] = seeded("kit")
    expect(Schema.is(Schema.String.check(Schema.isUUID(4)))(first)).toBe(true)
    expect(first).not.toBe(second)
    expect(seeded("kit")).toEqual([first, second])
    expect(seeded("other")[0]).not.toBe(first)
  })
})
