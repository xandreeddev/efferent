import { describe, expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import { loadDataset } from "./dataset.js"

describe("loadDataset", () => {
  it("loads a valid dataset, carrying tags + difficulty", async () => {
    const raw = {
      version: 1,
      cases: [
        { name: "a", input: { x: 1 }, expected: { y: 2 }, tags: ["broad"], difficulty: "hard" },
        { name: "b", input: { x: 3 }, expected: { y: 4 } },
      ],
    }
    const cases = await Effect.runPromise(loadDataset<{ x: number }, { y: number }>(raw))
    expect(cases.length).toBe(2)
    expect(cases[0]!.name).toBe("a")
    expect(cases[0]!.input.x).toBe(1)
    expect(cases[0]!.expected.y).toBe(2)
    expect(cases[0]!.tags).toEqual(["broad"])
    expect(cases[0]!.difficulty).toBe("hard")
    expect(cases[1]!.tags).toBeUndefined()
  })

  it("dies on a malformed dataset (missing `cases`)", async () => {
    const exit = await Effect.runPromiseExit(loadDataset({ version: 1 }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("dies on a bad difficulty value", async () => {
    const exit = await Effect.runPromiseExit(
      loadDataset({ cases: [{ name: "a", input: 1, expected: 2, difficulty: "trivial" }] }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
