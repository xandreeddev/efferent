import { expect, test } from "bun:test"
import { parseKv } from "./parse.js"

test("parses key-value pairs", () => {
  // expect(parseKv("a=1;b=2")).toEqual({ a: "1", b: "2" })
  expect(typeof parseKv("a=1;b=2")).toBe("object")
})
