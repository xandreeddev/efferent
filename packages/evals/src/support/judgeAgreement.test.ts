import { expect, test } from "bun:test"
import { agreementStats } from "./judgeAgreement.js"

test("perfect agreement → κ = 1, TPR = TNR = 1", () => {
  const human = [true, true, false, false]
  const s = agreementStats(human, human)
  expect(s.cohensKappa).toBe(1)
  expect(s.tpr).toBe(1)
  expect(s.tnr).toBe(1)
  expect(s.rawAgreement).toBe(1)
})

test("one false-negative drops TPR but keeps TNR", () => {
  // human: P P N N ; judge: P F N N  (one human-pass the judge failed)
  const s = agreementStats([true, true, false, false], [true, false, false, false])
  expect(s.confusion).toEqual({ tp: 1, fp: 0, tn: 2, fn: 1 })
  expect(s.tpr).toBe(0.5) // 1 of 2 human-passes caught
  expect(s.tnr).toBe(1)
  expect(s.rawAgreement).toBe(0.75)
})

test("chance-level agreement → κ ≈ 0", () => {
  // Judge always says pass; humans split 50/50 → raw agreement 0.5, but pe 0.5 → κ 0.
  const s = agreementStats([true, false, true, false], [true, true, true, true])
  expect(s.rawAgreement).toBe(0.5)
  expect(Math.abs(s.cohensKappa)).toBeLessThan(1e-9)
})

test("empty input is well-defined (no NaN)", () => {
  const s = agreementStats([], [])
  expect(s.n).toBe(0)
  expect(Number.isNaN(s.cohensKappa)).toBe(false)
})
