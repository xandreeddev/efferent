import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { cosine, notAVector, quoted } from "./embedder.entity.functions.js"

describe("how alike two vectors are", () => {
  test("cosine is 1 for one direction whatever the lengths, 0 across, -1 opposite, and its value between", () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBe(1)
    expect(cosine([1, 0], [0, 5])).toBe(0)
    expect(cosine([1, 1], [-3, -3])).toBe(-1)
    expect(cosine([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12)
    expect(cosine([3, 4], [4, 3])).toBeCloseTo(24 / 25, 12)
  })

  test("a vector of zeros is alike to nothing, itself included: 0", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0)
    expect(cosine([0, 0], [0, 0])).toBe(0)
  })

  test("vectors of two lengths are not compared: 0", () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0)
  })

  test("rounding never carries it past 1 or -1", () => {
    const vector = [0.1, 0.2, 0.3, 0.7, 1e-8, 123.456]
    expect(cosine(vector, vector)).toBeLessThanOrEqual(1)
    expect(cosine(vector, vector.map((x) => -x))).toBeGreaterThanOrEqual(-1)
  })
})

describe("numbers that are no vector", () => {
  test("none, or one that is not finite, is said in words; finite numbers are a vector", () => {
    expect(notAVector([])).toEqual(Option.some("it holds no number"))
    expect(notAVector([1, Number.NaN])).toEqual(Option.some("its number at 1 is NaN, not a finite number"))
    expect(notAVector([Number.POSITIVE_INFINITY])).toEqual(Option.some("its number at 0 is Infinity, not a finite number"))
    expect(notAVector([0, -1.5, 3])).toEqual(Option.none())
  })

  test("a text in words is quoted, a long one cut at 80 characters with what was cut counted, never half a character", () => {
    expect(quoted("a cat")).toBe("\"a cat\"")
    expect(quoted("x".repeat(100))).toBe(`${JSON.stringify("x".repeat(80))} [… 20 characters clipped]`)
    expect(quoted(`${"x".repeat(79)}😀 tail`)).toBe(`${JSON.stringify("x".repeat(79))} [… 7 characters clipped]`)
  })
})
