import { expect, test } from "bun:test"
import { Option } from "effect"
import { tighterOverflowBudget } from "./turn-overflow.entity.functions.js"

test("overflow tightens total input with one system/tool reserve and one context output reservation", () => {
  expect(Option.getOrNull(tighterOverflowBudget(10000, 200, 2000, { contextWindow: 1800, maxOutputTokens: 300 }))).toEqual({ inputCeiling: 1240, messageBudget: 1040 })
  expect(Option.getOrNull(tighterOverflowBudget(1000, 200, 2000, { contextWindow: 10000, maxOutputTokens: 300 }))).toEqual({ inputCeiling: 840, messageBudget: 640 })
  expect(Option.getOrNull(tighterOverflowBudget(10000, 200, 1000, {}))).toEqual({ inputCeiling: 1000, messageBudget: 800 })
})

test("unknown output leaves only a loose known input bound; output-only facts invent no capacity", () => {
  expect(Option.getOrNull(tighterOverflowBudget(10000, 200, 2000, { contextWindow: 1800 }))).toEqual({ inputCeiling: 1480, messageBudget: 1280 })
  expect(tighterOverflowBudget(10000, 200, 2000, { maxOutputTokens: 1000 })).toEqual(tighterOverflowBudget(10000, 200, 2000, {}))
})

test("no positive room or unsafe measurement cannot become a small recovery budget", () => {
  expect(Option.isNone(tighterOverflowBudget(1000, 1000, 500, {}))).toBe(true)
  expect(Option.isNone(tighterOverflowBudget(1000, 200, 500, { contextWindow: 1000, maxOutputTokens: 1000 }))).toBe(true)
  expect(Option.isNone(tighterOverflowBudget(1000, 200, Infinity, {}))).toBe(true)
  expect(Option.isNone(tighterOverflowBudget(1000, -200, 500, {}))).toBe(true)
  expect(Option.isNone(tighterOverflowBudget(1000, 200, 1, {}))).toBe(true)
  const huge = Option.getOrNull(tighterOverflowBudget(Number.MAX_SAFE_INTEGER, 200, Number.MAX_SAFE_INTEGER, {}))!
  expect(Number.isSafeInteger(huge.inputCeiling)).toBe(true)
  expect(huge.inputCeiling).toBeLessThan(Number.MAX_SAFE_INTEGER)
})
