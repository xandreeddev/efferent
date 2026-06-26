import { describe, expect, test } from "bun:test"
import { emptyHistory, historyNext, historyPrev, pushPrompt } from "./promptHistory.js"

describe("pushPrompt", () => {
  test("appends entries oldest→newest and stops browsing", () => {
    const h = pushPrompt(pushPrompt(emptyHistory, "first"), "second")
    expect(h.entries).toEqual(["first", "second"])
    expect(h.pos).toBeNull()
  })

  test("ignores blanks and consecutive duplicates", () => {
    let h = pushPrompt(emptyHistory, "  ")
    expect(h.entries).toEqual([])
    h = pushPrompt(pushPrompt(emptyHistory, "x"), "x")
    expect(h.entries).toEqual(["x"])
  })
})

describe("historyPrev / historyNext", () => {
  const seed = ["one", "two", "three"].reduce(pushPrompt, emptyHistory)

  test("↑ from a draft stashes it and jumps to the newest entry", () => {
    const r = historyPrev(seed, "my draft")
    expect(r?.text).toBe("three")
    expect(r?.history.pos).toBe(2)
    expect(r?.history.draft).toBe("my draft")
  })

  test("repeated ↑ steps toward the oldest, then stops", () => {
    let h = historyPrev(seed, "d")!.history // → three
    let r = historyPrev(h, "three") // → two
    expect(r?.text).toBe("two")
    h = r!.history
    r = historyPrev(h, "two") // → one
    expect(r?.text).toBe("one")
    expect(historyPrev(r!.history, "one")).toBeUndefined() // at oldest
  })

  test("↓ walks back toward newer, then restores the draft past the newest", () => {
    // browse up to "one"
    let h = historyPrev(seed, "draft")!.history // three
    h = historyPrev(h, "three")!.history // two
    h = historyPrev(h, "two")!.history // one (pos 0)
    let r = historyNext(h) // → two
    expect(r?.text).toBe("two")
    r = historyNext(r!.history) // → three
    expect(r?.text).toBe("three")
    r = historyNext(r!.history) // → draft (pos null)
    expect(r?.text).toBe("draft")
    expect(r?.history.pos).toBeNull()
  })

  test("↑ on empty history and ↓ while not browsing are no-ops", () => {
    expect(historyPrev(emptyHistory, "x")).toBeUndefined()
    expect(historyNext(seed)).toBeUndefined()
  })
})
