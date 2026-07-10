import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { initialVi, nextWordStart, prevWordStart, viNormalStep } from "./vi.js"

const normal = { mode: "normal" as const, pending: Option.none<"d">() }
const step = (key: string, text: string, cursor: number) =>
  Option.getOrThrow(viNormalStep(normal, key, text, cursor))

describe("vi word motions", () => {
  //           0123456789012345678
  const text = "port the stats mod"
  test("w jumps to the NEXT word start; b to the previous", () => {
    expect(nextWordStart(text, 0)).toBe(5)
    expect(nextWordStart(text, 5)).toBe(9)
    expect(nextWordStart(text, 15)).toBe(text.length)
    expect(prevWordStart(text, 9)).toBe(5)
    expect(prevWordStart(text, 5)).toBe(0)
    expect(prevWordStart(text, 0)).toBe(0)
  })
})

describe("vi normal mode", () => {
  test("h/l/0/$ move and clamp", () => {
    expect(step("h", "abc", 1).cursor).toBe(0)
    expect(step("h", "abc", 0).cursor).toBe(0)
    expect(step("l", "abc", 2).cursor).toBe(3)
    expect(step("0", "abc", 2).cursor).toBe(0)
    expect(step("$", "abc", 0).cursor).toBe(3)
  })

  test("x deletes at the cursor; empty buffer is a no-op", () => {
    const cut = step("x", "abc", 1)
    expect(cut.text).toBe("ac")
    expect(cut.cursor).toBe(1)
    expect(step("x", "", 0).text).toBeUndefined()
  })

  test("dd clears the line; dw deletes to the next word; a stray operator cancels", () => {
    const pending = step("d", "port the stats", 0)
    expect(Option.getOrThrow(pending.state.pending)).toBe("d")
    const cleared = Option.getOrThrow(
      viNormalStep(pending.state, "d", "port the stats", 0),
    )
    expect(cleared.text).toBe("")
    expect(cleared.cursor).toBe(0)
    const dw = Option.getOrThrow(viNormalStep(pending.state, "w", "port the stats", 0))
    expect(dw.text).toBe("the stats")
    const cancelled = Option.getOrThrow(viNormalStep(pending.state, "z", "x", 0))
    expect(Option.isNone(cancelled.state.pending)).toBe(true)
    expect(cancelled.text).toBeUndefined()
  })

  test("i/a/I/A enter insert at the right offsets", () => {
    expect(step("i", "abc", 1)).toMatchObject({ state: initialVi, cursor: 1 })
    expect(step("a", "abc", 1)).toMatchObject({ state: initialVi, cursor: 2 })
    expect(step("I", "abc", 2)).toMatchObject({ state: initialVi, cursor: 0 })
    expect(step("A", "abc", 0)).toMatchObject({ state: initialVi, cursor: 3 })
  })

  test("j/k delegate to the prompt ring; unknown keys are not ours", () => {
    expect(step("k", "", 0).recall).toBe("up")
    expect(step("j", "", 0).recall).toBe("down")
    expect(Option.isNone(viNormalStep(normal, "q", "abc", 0))).toBe(true)
  })

  test("za toggles folds; z + anything else cancels", () => {
    const zPending = step("z", "", 0)
    expect(Option.getOrThrow(zPending.state.pending)).toBe("z")
    const toggled = Option.getOrThrow(viNormalStep(zPending.state, "a", "", 0))
    expect(toggled.toggleFold).toBe(true)
    const cancelled = Option.getOrThrow(viNormalStep(zPending.state, "x", "", 0))
    expect(cancelled.toggleFold).toBeUndefined()
    expect(Option.isNone(cancelled.state.pending)).toBe(true)
  })
})
