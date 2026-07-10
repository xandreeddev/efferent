import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { initialHistory, pushHistory, recallStep } from "./history.js"

const seeded = ["first", "second", "third"].reduce(pushHistory, initialHistory)

describe("the composer prompt ring", () => {
  test("push collapses consecutive duplicates and caps at 50", () => {
    const doubled = pushHistory(pushHistory(initialHistory, "same"), "same")
    expect(doubled.entries).toEqual(["same"])
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`).reduce(
      pushHistory,
      initialHistory,
    )
    expect(many.entries).toHaveLength(50)
    expect(many.entries[0]).toBe("p10")
  })

  test("↑ from an EMPTY composer walks newest → oldest and clamps at the top", () => {
    const one = Option.getOrThrow(recallStep(seeded, "up", ""))
    expect(one.text).toBe("third")
    const two = Option.getOrThrow(recallStep(one.state, "up", "third"))
    expect(two.text).toBe("second")
    const three = Option.getOrThrow(recallStep(two.state, "up", "second"))
    expect(three.text).toBe("first")
    const clamped = Option.getOrThrow(recallStep(three.state, "up", "first"))
    expect(clamped.text).toBe("first")
  })

  test("↓ walks back and exits to an empty composer past the newest", () => {
    const up = Option.getOrThrow(recallStep(seeded, "up", ""))
    const down = Option.getOrThrow(recallStep(up.state, "down", "third"))
    expect(down.text).toBe("")
    expect(Option.isNone(down.state.cursor)).toBe(true)
  })

  test("mid-edit, the keys are NOT ours (typed text detaches the recall)", () => {
    // Non-empty fresh composer: ↑ falls through.
    expect(Option.isNone(recallStep(seeded, "up", "typing something"))).toBe(true)
    // Recalled then edited: further navigation falls through too.
    const up = Option.getOrThrow(recallStep(seeded, "up", ""))
    expect(Option.isNone(recallStep(up.state, "up", "third — edited"))).toBe(true)
  })

  test("submitting a recalled prompt resets the cursor", () => {
    const up = Option.getOrThrow(recallStep(seeded, "up", ""))
    const pushed = pushHistory(up.state, "third")
    expect(Option.isNone(pushed.cursor)).toBe(true)
  })
})
