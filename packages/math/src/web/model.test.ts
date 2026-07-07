import { Option } from "effect"
import { describe, expect, test } from "bun:test"
import type { MathExercise, MathItem } from "../domain/MathContent.js"
import {
  advance,
  applyGrade,
  applyReport,
  applyReveal,
  applyTopic,
  canNext,
  drainProgress,
  emptyMathModel,
  findExercise,
  putItems,
  setError,
  setGenerating,
  unservedCount,
} from "./model.js"

const ex = (id: string, over: Partial<MathExercise> = {}): MathExercise => ({
  kind: "exercise",
  id,
  prompt: `What is 1/4 + 2/4? (${id})`,
  answer: { kind: "fraction", value: "3/4" },
  hint: "Add the numerators.",
  solution: [{ text: "1/4 + 2/4 = 3/4" }],
  ...over,
})

const batch = (...ids: ReadonlyArray<string>): ReadonlyArray<MathItem> => ids.map((i) => ex(i))

describe("math model", () => {
  test("putItems: upsert by id, auto-serve first, note replaces, started flips", () => {
    const m0 = emptyMathModel({ grade: 4, theme: "fractions" })
    expect(m0.started).toBe(false)
    const m1 = putItems(m0, [...batch("ex-1", "ex-2"), { kind: "note", text: "hi" }])
    expect(m1.started).toBe(true)
    expect(m1.currentId).toBe("ex-1")
    expect(m1.note).toBe("hi")
    expect(m1.exercises).toHaveLength(2)
    // Re-sent id replaces, never duplicates.
    const m2 = putItems(m1, [ex("ex-2", { prompt: "updated" })])
    expect(m2.exercises).toHaveLength(2)
    expect(Option.getOrUndefined(findExercise(m2, "ex-2"))?.item.prompt).toBe("updated")
  })

  test("grade tiers: wrong → hint tier, wrong again → solution tier, correct → solved + progress", () => {
    const m0 = putItems(emptyMathModel(), batch("ex-1"))
    const r1 = applyGrade(m0, "ex-1", "2/6")
    expect(r1.graded).toBe(true)
    expect(Option.getOrUndefined(findExercise(r1.model, "ex-1"))?.verdict).toBe("wrong")
    expect(Option.getOrUndefined(findExercise(r1.model, "ex-1"))?.attempts).toBe(1)
    const r2 = applyGrade(r1.model, "ex-1", "2/4")
    expect(Option.getOrUndefined(findExercise(r2.model, "ex-1"))?.attempts).toBe(2)
    const r3 = applyGrade(r2.model, "ex-1", "6/8") // equivalent form of 3/4
    expect(Option.getOrUndefined(findExercise(r3.model, "ex-1"))?.verdict).toBe("correct")
    expect(r3.model.solved).toBe(1)
    expect(r3.model.pendingProgress).toEqual([{ ex: "ex-1", result: "correct", attempts: 3 }])
    // A done exercise refuses further grading.
    expect(applyGrade(r3.model, "ex-1", "3/4").graded).toBe(false)
  })

  test("advance abandons a wrong-in-progress exercise honestly (gave-up entry, never re-serves)", () => {
    const m0 = applyGrade(putItems(emptyMathModel(), batch("ex-1", "ex-2")), "ex-1", "nope").model
    const m1 = advance(m0)
    expect(m1.currentId).toBe("ex-2")
    expect(m1.pendingProgress).toEqual([
      { ex: "ex-1", result: "wrong", attempts: 1, gaveUp: true },
    ])
    expect(Option.getOrUndefined(findExercise(m1, "ex-1"))?.verdict).not.toBe("fresh")
    // ex-1 never comes back.
    const m2 = advance(m1)
    expect(m2.currentId).toBe("ex-2")
  })

  test("reveal and report record progress; report excludes from solved and advances", () => {
    const m0 = applyReveal(putItems(emptyMathModel(), batch("ex-1", "ex-2")), "ex-1")
    expect(Option.getOrUndefined(findExercise(m0, "ex-1"))?.verdict).toBe("revealed")
    const m1 = applyGrade(m0, "ex-2", "3/4").model
    expect(m1.solved).toBe(1)
    const m2 = applyReport(m1, "ex-2")
    expect(m2.solved).toBe(0)
    const [entries] = drainProgress(m2)
    expect(entries.map((e) => e.result)).toEqual(["revealed", "correct", "reported"])
    expect(entries[2]?.key).toBe("3/4")
  })

  test("drainProgress empties the pending list exactly once", () => {
    const m = applyGrade(putItems(emptyMathModel(), batch("ex-1")), "ex-1", "3/4").model
    const [entries, drained] = drainProgress(m)
    expect(entries).toHaveLength(1)
    expect(drainProgress(drained)[0]).toHaveLength(0)
  })

  test("topic switch drops unserved, keeps answered history, resets current", () => {
    const graded = applyGrade(
      putItems(emptyMathModel({ grade: 4, theme: "fractions" }), batch("ex-1", "ex-2", "ex-3")),
      "ex-1",
      "3/4",
    ).model
    const m = applyTopic(graded, 6, "decimals")
    expect(m.grade).toBe(6)
    expect(m.theme).toBe("decimals")
    expect(m.exercises.map((e) => e.item.id)).toEqual(["ex-1"]) // answered stays
    expect(m.currentId).toBeUndefined()
    // The next batch serves fresh.
    const m2 = putItems(m, batch("ex-4"))
    expect(m2.currentId).toBe("ex-4")
  })

  test("unserved/canNext drive Next + auto-refill; generating clears errors", () => {
    const m0 = putItems(emptyMathModel(), batch("ex-1", "ex-2", "ex-3"))
    expect(unservedCount(m0)).toBe(2)
    expect(canNext(m0)).toBe(true)
    const m1 = setError(m0, "boom")
    expect(m1.lastError?.message).toBe("boom")
    const m2 = setGenerating(m1, true)
    expect(m2.lastError).toBeUndefined()
    expect(m2.acceptedThisTurn).toBe(0)
  })
})
