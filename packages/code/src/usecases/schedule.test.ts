import { describe, expect, it } from "bun:test"
import { cronMatches, minuteBucket, parseCron, parseScheduleArg } from "./schedule.js"

const matches = (expr: string, date: Date): boolean => {
  const f = parseCron(expr)
  if (f === undefined) throw new Error(`bad cron ${expr}`)
  return cronMatches(f, date)
}

describe("parseCron", () => {
  it("accepts 5-field expressions with *, lists, ranges, steps", () => {
    for (const e of ["* * * * *", "0 9 * * 1", "*/15 * * * *", "0 0,12 1-5 * *", "30 9-17/2 * * 1-5"]) {
      expect(parseCron(e)).not.toBeUndefined()
    }
  })
  it("rejects wrong arity / out-of-range / garbage", () => {
    for (const e of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "abc * * * *", ""]) {
      expect(parseCron(e)).toBeUndefined()
    }
  })
})

describe("cronMatches", () => {
  it("'* * * * *' matches any minute", () => {
    expect(matches("* * * * *", new Date(2026, 5, 19, 13, 37))).toBe(true)
  })
  it("'0 9 * * *' matches 09:00 only", () => {
    expect(matches("0 9 * * *", new Date(2026, 0, 1, 9, 0))).toBe(true)
    expect(matches("0 9 * * *", new Date(2026, 0, 1, 9, 1))).toBe(false)
    expect(matches("0 9 * * *", new Date(2026, 0, 1, 10, 0))).toBe(false)
  })
  it("steps + ranges", () => {
    expect(matches("*/15 * * * *", new Date(2026, 0, 1, 0, 30))).toBe(true)
    expect(matches("*/15 * * * *", new Date(2026, 0, 1, 0, 31))).toBe(false)
    expect(matches("1-5 * * * *", new Date(2026, 0, 1, 0, 3))).toBe(true)
    expect(matches("1-5 * * * *", new Date(2026, 0, 1, 0, 6))).toBe(false)
  })
  it("dom + dow use OR when both are restricted", () => {
    // Build a date, then a cron that restricts dom to a non-matching day but dow
    // to this date's weekday → should match via the dow branch.
    const d = new Date(2026, 0, 15, 0, 0) // the 15th
    const otherDom = 2 // not the 15th
    expect(matches(`0 0 ${otherDom} * ${d.getDay()}`, d)).toBe(true) // dow hit
    expect(matches(`0 0 15 * ${(d.getDay() + 1) % 7}`, d)).toBe(true) // dom hit
    expect(matches(`0 0 ${otherDom} * ${(d.getDay() + 1) % 7}`, d)).toBe(false) // neither
  })
})

describe("minuteBucket", () => {
  it("buckets epoch-ms into minutes", () => {
    expect(minuteBucket(0)).toBe(0)
    expect(minuteBucket(59_999)).toBe(0)
    expect(minuteBucket(60_000)).toBe(1)
  })
})

describe("parseScheduleArg", () => {
  it("parses cron :: folder :: prompt [:: agent]", () => {
    expect(parseScheduleArg("0 9 * * 1 :: . :: review open PRs")).toEqual({
      cron: "0 9 * * 1",
      folder: ".",
      prompt: "review open PRs",
    })
    expect(parseScheduleArg("*/30 * * * * :: src :: sweep TODOs :: reviewer")).toEqual({
      cron: "*/30 * * * *",
      folder: "src",
      prompt: "sweep TODOs",
      agent: "reviewer",
    })
  })
  it("rejects too few parts or an invalid cron", () => {
    expect(parseScheduleArg("0 9 * * 1 :: .")).toBeUndefined()
    expect(parseScheduleArg("not a cron :: . :: do it")).toBeUndefined()
  })
})
