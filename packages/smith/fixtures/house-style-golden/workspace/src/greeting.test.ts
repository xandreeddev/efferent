import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { greet } from "./greeting.js"

describe("greet", () => {
  test("greets the world when absent", () => {
    expect(greet(Option.none())).toBe("hello, world")
  })
  test("greets the person when present", () => {
    expect(greet(Option.some("ada"))).toBe("hello, ada")
  })
})
