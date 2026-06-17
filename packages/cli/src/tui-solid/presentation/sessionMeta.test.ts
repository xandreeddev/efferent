import { describe, expect, it } from "bun:test"
import { relativeTime, sessionMeta } from "./sessionMeta.js"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe("relativeTime", () => {
  const now = 1_000 * DAY
  it("rounds to friendly buckets", () => {
    expect(relativeTime(now, now)).toBe("just now")
    expect(relativeTime(now - 10_000, now)).toBe("just now")
    expect(relativeTime(now - 5 * MIN, now)).toBe("5m ago")
    expect(relativeTime(now - 3 * HOUR, now)).toBe("3h ago")
    expect(relativeTime(now - 2 * DAY, now)).toBe("2d ago")
    expect(relativeTime(now - 10 * DAY, now)).toBe("1w ago")
  })
  it("never shows a negative or 0m duration", () => {
    expect(relativeTime(now + 5000, now)).toBe("just now") // clock skew
    expect(relativeTime(now - 50_000, now)).toBe("1m ago")
  })
})

describe("sessionMeta", () => {
  const now = 1_000 * DAY
  it("singularizes the message count and joins with the time", () => {
    expect(sessionMeta(1, now - 2 * HOUR, now)).toBe("1 msg · 2h ago")
    expect(sessionMeta(12, now - 5 * MIN, now)).toBe("12 msgs · 5m ago")
  })
  it("omits unknown pieces", () => {
    expect(sessionMeta(undefined, now, now)).toBe("just now")
    expect(sessionMeta(3, undefined, now)).toBe("3 msgs")
    expect(sessionMeta(undefined, undefined, now)).toBe("")
  })
})
