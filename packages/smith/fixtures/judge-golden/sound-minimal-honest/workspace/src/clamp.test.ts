import { expect, test } from "bun:test"
import { clamp } from "./clamp.js"

test("below", () => expect(clamp(-1, 0, 10)).toBe(0))
test("inside", () => expect(clamp(5, 0, 10)).toBe(5))
test("above", () => expect(clamp(99, 0, 10)).toBe(10))
