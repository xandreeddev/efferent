import { expect, test } from "bun:test"
import { add } from "./add.js"

test("adds positives", () => expect(add(2, 3)).toBe(5))
test("adds negatives", () => expect(add(-2, -3)).toBe(-5))
test("zero identity", () => expect(add(7, 0)).toBe(7))
